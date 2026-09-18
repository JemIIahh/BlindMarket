import { expect } from "chai";
import { ethers, network } from "../lib/hh.js";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types";

/**
 * Off-chain CREATE2 address computation.
 * Matches the factory's createAccount bytecode deployment.
 */
function computeSmartAccountAddress(
  factoryAddr: string,
  owner: string,
  salt: string,
  creationCode: string,
  usdcAddr: string,
  paymasterAddr: string,
): string {
  const constructorArgs = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "address", "address"],
    [owner, usdcAddr, paymasterAddr],
  );
  const initCode = ethers.concat([creationCode, constructorArgs]);
  const initCodeHash = ethers.keccak256(initCode);
  return ethers.getCreate2Address(factoryAddr, salt, initCodeHash);
}

describe("BlindAccount", function () {
  let account: any;
  let usdc: any;
  let paymaster: any;
  let factory: any;
  let mockEP: any;
  let owner: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let bundler: HardhatEthersSigner;

  const SALT = ethers.keccak256(ethers.toUtf8Bytes("test-salt-1"));
  let creationCode: string;

  beforeEach(async function () {
    [owner, stranger, bundler] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("MockERC20");
    usdc = await Token.deploy("Mock USDC", "MUSDC", 6);

    const MockEP = await ethers.getContractFactory("MockEntryPoint");
    mockEP = await MockEP.deploy();

    const Paymaster = await ethers.getContractFactory("USDCPaymaster");
    paymaster = await Paymaster.deploy(await mockEP.getAddress(), await usdc.getAddress(), 3_000_000_000n);

    const Factory = await ethers.getContractFactory("BlindAccountFactory");
    factory = await Factory.deploy(await mockEP.getAddress(), await usdc.getAddress(), await paymaster.getAddress());

    const BA = await ethers.getContractFactory("BlindAccount");
    creationCode = BA.bytecode;

    // Compute address off-chain and deploy
    const accountAddr = computeSmartAccountAddress(
      await factory.getAddress(), owner.address, SALT, creationCode, await usdc.getAddress(), await paymaster.getAddress(),
    );
    await factory.createAccount(owner.address, SALT);
    account = await ethers.getContractAt("BlindAccount", accountAddr);

    // Fund the account with USDC and ETH
    await usdc.mint(accountAddr, ethers.parseUnits("1000", 6));
    await owner.sendTransaction({ to: accountAddr, value: ethers.parseEther("1") });

    await mockEP.connect(bundler).depositFor(await paymaster.getAddress(), { value: ethers.parseEther("1") });
  });

  describe("initialization", function () {
    it("sets the correct owner", async function () {
      expect(await account.owner()).to.equal(owner.address);
    });

    it("pre-approves the paymaster to spend USDC", async function () {
      const accountAddr = await account.getAddress();
      const allowance = await usdc.allowance(accountAddr, await paymaster.getAddress());
      expect(allowance).to.equal(ethers.MaxUint256);
    });

    it("starts with the correct ETH balance", async function () {
      const accountAddr = await account.getAddress();
      expect(await ethers.provider.getBalance(accountAddr)).to.equal(ethers.parseEther("1"));
    });

    it("starts with the correct USDC balance", async function () {
      const accountAddr = await account.getAddress();
      expect(await usdc.balanceOf(accountAddr)).to.equal(ethers.parseUnits("1000", 6));
    });
  });

  describe("execute", function () {
    it("allows the owner to send ETH", async function () {
      const balanceBefore = await ethers.provider.getBalance(stranger.address);
      await account.execute(stranger.address, ethers.parseEther("0.01"), "0x");
      const balanceAfter = await ethers.provider.getBalance(stranger.address);
      expect(balanceAfter - balanceBefore).to.equal(ethers.parseEther("0.01"));
    });

    it("allows the owner to call contracts (USDC transfer)", async function () {
      const transferAmount = ethers.parseUnits("100", 6);
      const calldata = usdc.interface.encodeFunctionData("transfer", [stranger.address, transferAmount]);
      await account.execute(await usdc.getAddress(), 0, calldata);
      expect(await usdc.balanceOf(stranger.address)).to.equal(transferAmount);
    });

    it("reverts when called by non-owner", async function () {
      await expect(
        account.connect(stranger).execute(stranger.address, ethers.parseEther("0.01"), "0x"),
      ).to.be.revertedWith("BlindAccount: not owner nor entrypoint");
    });

    // Regression: the real ERC-4337 flow has the EntryPoint (not the owner
    // EOA) call execute(). A strict onlyOwner passed every test above yet
    // reverted all live UserOps on Base Sepolia — this impersonates the
    // canonical v0.7 EntryPoint to pin the actual call path.
    it("allows the EntryPoint to execute (ERC-4337 flow)", async function () {
      const EP = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
      expect((await account.entryPoint()).toLowerCase()).to.equal(EP.toLowerCase());
      await network.provider.request({ method: "hardhat_impersonateAccount", params: [EP] });
      await network.provider.request({ method: "hardhat_setBalance", params: [EP, "0x8AC7230489E80000"] });
      const epSigner = await ethers.getSigner(EP);
      const balanceBefore = await ethers.provider.getBalance(stranger.address);
      await account.connect(epSigner).execute(stranger.address, ethers.parseEther("0.01"), "0x");
      const balanceAfter = await ethers.provider.getBalance(stranger.address);
      expect(balanceAfter - balanceBefore).to.equal(ethers.parseEther("0.01"));
    });

    it("reverts on failed inner call", async function () {
      const calldata = usdc.interface.encodeFunctionData("transfer", [
        stranger.address,
        ethers.parseUnits("9999", 6),
      ]);
      await expect(
        account.execute(await usdc.getAddress(), 0, calldata),
      ).to.revert(ethers);
    });
  });

  describe("executeBatch", function () {
    it("executes multiple calls atomically", async function () {
      const amt1 = ethers.parseUnits("50", 6);
      const amt2 = ethers.parseUnits("25", 6);

      const calldata1 = usdc.interface.encodeFunctionData("transfer", [stranger.address, amt1]);
      const calldata2 = usdc.interface.encodeFunctionData("transfer", [bundler.address, amt2]);

      await account.executeBatch(
        [await usdc.getAddress(), await usdc.getAddress()],
        [0, 0],
        [calldata1, calldata2],
      );

      expect(await usdc.balanceOf(stranger.address)).to.equal(amt1);
      expect(await usdc.balanceOf(bundler.address)).to.equal(amt2);
    });

    it("reverts if arrays have mismatched lengths", async function () {
      await expect(
        account.executeBatch([stranger.address], [0, 0], ["0x"]),
      ).to.be.revertedWith("BlindAccount: length mismatch");
    });

    it("reverts when called by non-owner", async function () {
      await expect(
        account.connect(stranger).executeBatch([stranger.address], [0], ["0x"]),
      ).to.be.revertedWith("BlindAccount: not owner nor entrypoint");
    });
  });

  describe("receive ETH", function () {
    it("accepts ETH transfers", async function () {
      const accountAddr = await account.getAddress();
      const balBefore = await ethers.provider.getBalance(accountAddr);
      await owner.sendTransaction({ to: accountAddr, value: ethers.parseEther("0.1") });
      const balAfter = await ethers.provider.getBalance(accountAddr);
      expect(balAfter - balBefore).to.equal(ethers.parseEther("0.1"));
    });
  });

  describe("ERC-4337 entryPoint", function () {
    it("returns a valid entrypoint address", async function () {
      const ep = await account.entryPoint();
      expect(ep).to.be.properAddress;
    });
  });
});

describe("BlindAccountFactory", function () {
  let factory: any;
  let usdc: any;
  let paymaster: any;
  let mockEP: any;
  let creationCode: string;
  let owner: HardhatEthersSigner;
  let user: HardhatEthersSigner;

  beforeEach(async function () {
    [owner, user] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("MockERC20");
    usdc = await Token.deploy("Mock USDC", "MUSDC", 6);

    const MockEP = await ethers.getContractFactory("MockEntryPoint");
    mockEP = await MockEP.deploy();

    const Paymaster = await ethers.getContractFactory("USDCPaymaster");
    paymaster = await Paymaster.deploy(await mockEP.getAddress(), await usdc.getAddress(), 3_000_000_000n);

    const Factory = await ethers.getContractFactory("BlindAccountFactory");
    factory = await Factory.deploy(await mockEP.getAddress(), await usdc.getAddress(), await paymaster.getAddress());

    const BA = await ethers.getContractFactory("BlindAccount");
    creationCode = BA.bytecode;
  });

  describe("createAccount", function () {
    it("deploys a BlindAccount at the deterministic address", async function () {
      const salt = ethers.keccak256(ethers.toUtf8Bytes("deploy1"));
      const expectedAddr = computeSmartAccountAddress(
        await factory.getAddress(), owner.address, salt, creationCode, await usdc.getAddress(), await paymaster.getAddress(),
      );
      await factory.createAccount(owner.address, salt);
      const code = await ethers.provider.getCode(expectedAddr);
      expect(code).to.not.equal("0x");
      expect(code.length).to.be.greaterThan(2);
    });

    it("is idempotent — second call returns same address without redeployment", async function () {
      const salt = ethers.keccak256(ethers.toUtf8Bytes("deploy2"));
      const addr1 = await factory.createAccount(owner.address, salt);
      const tx2 = await factory.createAccount(owner.address, salt);
      const receipt2 = await tx2.wait();
      expect(receipt2!.gasUsed).to.be.lessThan(50000n);
    });

    it("initializes the account with the correct owner", async function () {
      const salt = ethers.keccak256(ethers.toUtf8Bytes("deploy3"));
      const expectedAddr = computeSmartAccountAddress(
        await factory.getAddress(), owner.address, salt, creationCode, await usdc.getAddress(), await paymaster.getAddress(),
      );
      await factory.createAccount(owner.address, salt);
      const account = await ethers.getContractAt("BlindAccount", expectedAddr);
      expect(await account.owner()).to.equal(owner.address);
    });

    it("pre-approves the paymaster in the account", async function () {
      const salt = ethers.keccak256(ethers.toUtf8Bytes("deploy4"));
      const expectedAddr = computeSmartAccountAddress(
        await factory.getAddress(), owner.address, salt, creationCode, await usdc.getAddress(), await paymaster.getAddress(),
      );
      await factory.createAccount(owner.address, salt);
      const allowance = await usdc.allowance(expectedAddr, await paymaster.getAddress());
      expect(allowance).to.equal(ethers.MaxUint256);
    });

    it("exposes accountImplementation address", async function () {
      const impl = await factory.accountImplementation();
      expect(impl).to.be.properAddress;
      const code = await ethers.provider.getCode(impl);
      expect(code.length).to.be.greaterThan(2);
    });

    it("different owners produce different addresses", async function () {
      const salt = ethers.keccak256(ethers.toUtf8Bytes("unique"));
      const addr1 = computeSmartAccountAddress(
        await factory.getAddress(), owner.address, salt, creationCode, await usdc.getAddress(), await paymaster.getAddress(),
      );
      const addr2 = computeSmartAccountAddress(
        await factory.getAddress(), user.address, salt, creationCode, await usdc.getAddress(), await paymaster.getAddress(),
      );
      expect(addr1).to.not.equal(addr2);
    });

    it("different salts produce different addresses", async function () {
      const salt1 = ethers.keccak256(ethers.toUtf8Bytes("s1"));
      const salt2 = ethers.keccak256(ethers.toUtf8Bytes("s2"));
      const addr1 = computeSmartAccountAddress(
        await factory.getAddress(), owner.address, salt1, creationCode, await usdc.getAddress(), await paymaster.getAddress(),
      );
      const addr2 = computeSmartAccountAddress(
        await factory.getAddress(), owner.address, salt2, creationCode, await usdc.getAddress(), await paymaster.getAddress(),
      );
      expect(addr1).to.not.equal(addr2);
    });

    it("caches the deployed address in the accounts mapping", async function () {
      const salt = ethers.keccak256(ethers.toUtf8Bytes("cache"));
      const expectedAddr = computeSmartAccountAddress(
        await factory.getAddress(), owner.address, salt, creationCode, await usdc.getAddress(), await paymaster.getAddress(),
      );
      await factory.createAccount(owner.address, salt);
      expect(await factory.accounts(owner.address)).to.equal(expectedAddr);
    });
  });
});

describe("USDCPaymaster", function () {
  let paymaster: any;
  let usdc: any;
  let mockEP: any;
  let owner: HardhatEthersSigner;
  let sender: HardhatEthersSigner;

  const ETH_PRICE_USDC = 3_000_000_000n;

  beforeEach(async function () {
    [owner, sender] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("MockERC20");
    usdc = await Token.deploy("Mock USDC", "MUSDC", 6);

    const MockEP = await ethers.getContractFactory("MockEntryPoint");
    mockEP = await MockEP.deploy();

    const Paymaster = await ethers.getContractFactory("USDCPaymaster");
    paymaster = await Paymaster.deploy(await mockEP.getAddress(), await usdc.getAddress(), ETH_PRICE_USDC);

    await mockEP.depositFor(await paymaster.getAddress(), { value: ethers.parseEther("1") });
  });

  describe("deposit", function () {
    it("forwards ETH to EntryPoint", async function () {
      const pmAddr = await paymaster.getAddress();
      const balBefore = await ethers.provider.getBalance(pmAddr);
      await paymaster.deposit({ value: ethers.parseEther("0.5") });
      const balAfter = await ethers.provider.getBalance(pmAddr);
      expect(balAfter).to.equal(balBefore);
    });
  });

  describe("setEthPrice", function () {
    it("owner can update the price", async function () {
      await paymaster.setEthPrice(4_000_000_000n);
      expect(await paymaster.ethPriceInUsdc()).to.equal(4_000_000_000n);
    });

    it("reverts for non-owner", async function () {
      await expect(
        paymaster.connect(sender).setEthPrice(4_000_000_000n),
      ).to.be.revertedWithCustomError(paymaster, "NotOwner");
    });
  });

  describe("withdrawEth", function () {
    it("owner can withdraw ETH from EntryPoint", async function () {
      const withdrawAmount = ethers.parseEther("0.1");
      const balBefore = await ethers.provider.getBalance(owner.address);
      await paymaster.withdrawEth(owner.address, withdrawAmount);
      const balAfter = await ethers.provider.getBalance(owner.address);
      expect(balAfter).to.be.greaterThan(balBefore);
    });

    it("reverts for non-owner", async function () {
      await expect(
        paymaster.connect(sender).withdrawEth(sender.address, ethers.parseEther("0.1")),
      ).to.be.revertedWithCustomError(paymaster, "NotOwner");
    });
  });

  describe("validatePaymasterUserOp", function () {
    it("reverts when called by non-EntryPoint", async function () {
      const userOp = {
        sender: owner.address,
        nonce: 0,
        initCode: "0x",
        callData: "0x",
        accountGasLimits: ethers.solidityPacked(["uint128", "uint128"], [200000n, 100000n]),
        preVerificationGas: 10000n,
        gasFees: ethers.solidityPacked(["uint128", "uint128"], [1000000000n, 10000000000n]),
        paymasterAndData: "0x",
        signature: "0x",
      };
      const userOpHash = ethers.keccak256(ethers.toUtf8Bytes("test-hash"));
      await expect(
        paymaster.validatePaymasterUserOp(userOp, userOpHash, ethers.parseEther("1")),
      ).to.be.revertedWithCustomError(paymaster, "NotEntryPoint");
    });
  });

  describe("postOp", function () {
    it("reverts when called by non-EntryPoint", async function () {
      await expect(paymaster.postOp(0, "0x", 0, 0)).to.be.revertedWithCustomError(paymaster, "NotEntryPoint");
    });
  });

  describe("receive ETH", function () {
    it("accepts direct ETH transfers", async function () {
      const pmAddr = await paymaster.getAddress();
      const balBefore = await ethers.provider.getBalance(pmAddr);
      await owner.sendTransaction({ to: pmAddr, value: ethers.parseEther("0.01") });
      const balAfter = await ethers.provider.getBalance(pmAddr);
      expect(balAfter - balBefore).to.equal(ethers.parseEther("0.01"));
    });
  });

  describe("events", function () {
    it("emits EthPriceUpdated", async function () {
      await expect(paymaster.setEthPrice(5_000_000_000n))
        .to.emit(paymaster, "EthPriceUpdated").withArgs(5_000_000_000n);
    });

    it("emits Deposited", async function () {
      await expect(paymaster.deposit({ value: ethers.parseEther("0.1") }))
        .to.emit(paymaster, "Deposited").withArgs(owner.address, ethers.parseEther("0.1"));
    });

    it("emits Withdrawn", async function () {
      const amount = ethers.parseEther("0.05");
      await expect(paymaster.withdrawEth(owner.address, amount))
        .to.emit(paymaster, "Withdrawn").withArgs(owner.address, amount);
    });
  });
});

describe("Integration: Factory → Account → Paymaster", function () {
  let factory: any;
  let paymaster: any;
  let mockEP: any;
  let usdc: any;
  let creationCode: string;
  let owner: HardhatEthersSigner;

  beforeEach(async function () {
    [owner] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("MockERC20");
    usdc = await Token.deploy("Mock USDC", "MUSDC", 6);

    const MockEP = await ethers.getContractFactory("MockEntryPoint");
    mockEP = await MockEP.deploy();

    const Paymaster = await ethers.getContractFactory("USDCPaymaster");
    paymaster = await Paymaster.deploy(await mockEP.getAddress(), await usdc.getAddress(), 3_000_000_000n);

    const Factory = await ethers.getContractFactory("BlindAccountFactory");
    factory = await Factory.deploy(await mockEP.getAddress(), await usdc.getAddress(), await paymaster.getAddress());

    const BA = await ethers.getContractFactory("BlindAccount");
    creationCode = BA.bytecode;
  });

  it("full lifecycle: deploy → fund → execute → paymaster", async function () {
    const salt = ethers.keccak256(ethers.toUtf8Bytes("lifecycle-" + Date.now()));

    const expectedAddr = computeSmartAccountAddress(
      await factory.getAddress(), owner.address, salt, creationCode, await usdc.getAddress(), await paymaster.getAddress(),
    );

    await factory.createAccount(owner.address, salt);
    const account = await ethers.getContractAt("BlindAccount", expectedAddr);

    expect(await account.owner()).to.equal(owner.address);
    expect(await usdc.allowance(expectedAddr, await paymaster.getAddress())).to.equal(ethers.MaxUint256);

    await usdc.mint(expectedAddr, ethers.parseUnits("100", 6));
    expect(await usdc.balanceOf(expectedAddr)).to.equal(ethers.parseUnits("100", 6));

    const transferAmt = ethers.parseUnits("42", 6);
    const calldata = usdc.interface.encodeFunctionData("transfer", [owner.address, transferAmt]);
    await account.execute(await usdc.getAddress(), 0, calldata);
    expect(await usdc.balanceOf(expectedAddr)).to.equal(ethers.parseUnits("58", 6));

    await mockEP.depositFor(await paymaster.getAddress(), { value: ethers.parseEther("1") });
    await owner.sendTransaction({ to: expectedAddr, value: ethers.parseEther("0.1") });
    expect(await ethers.provider.getBalance(expectedAddr)).to.equal(ethers.parseEther("0.1"));

    await account.execute(owner.address, ethers.parseEther("0.05"), "0x");
    expect(await ethers.provider.getBalance(expectedAddr)).to.equal(ethers.parseEther("0.05"));
  });

  it("different owners get different account addresses", async function () {
    const salt = ethers.keccak256(ethers.toUtf8Bytes("unique"));

    const allSigners = await ethers.getSigners();
    const owner1 = allSigners[0];
    const owner2 = allSigners[1];

    const addr1 = computeSmartAccountAddress(
      await factory.getAddress(), owner1.address, salt, creationCode, await usdc.getAddress(), await paymaster.getAddress(),
    );
    const addr2 = computeSmartAccountAddress(
      await factory.getAddress(), owner2.address, salt, creationCode, await usdc.getAddress(), await paymaster.getAddress(),
    );
    expect(addr1).to.not.equal(addr2);
  });
});
