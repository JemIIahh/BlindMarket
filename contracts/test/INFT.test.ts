import { expect } from "chai";
import { ethers } from "hardhat";

// Focused coverage for #27: a usage authorization granted by an owner must NOT
// survive a change of ownership — including via the inherited ERC-721
// transferFrom / safeTransferFrom, not just transferWithProof.
describe("INFT — usage authorization invalidation (#27)", () => {
  let inft: any;
  let owner: any, buyer: any, executor: any;
  const PERMS = "0x1234";

  beforeEach(async () => {
    [owner, buyer, executor] = await ethers.getSigners();
    // The oracle is only consulted by transferWithProof/clone; these tests use
    // the plain ERC-721 transfer path, so any non-zero address suffices.
    const INFT = await ethers.getContractFactory("INFT");
    inft = await INFT.deploy(buyer.address);
    await inft.mint(owner.address, "ipfs://meta", ethers.ZeroHash); // tokenId 1, onlyOwner=deployer
  });

  it("invalidates authorizations on a standard transferFrom (the bypass path)", async () => {
    await inft.authorizeUsage(1, executor.address, PERMS);
    expect(await inft.isAuthorized(1, executor.address)).to.equal(true);

    await inft.transferFrom(owner.address, buyer.address, 1);

    // The previous owner's grant must not carry over to the new owner.
    expect(await inft.isAuthorized(1, executor.address)).to.equal(false);
    expect(await inft.getAuthorization(1, executor.address)).to.equal("0x");
  });

  it("invalidates authorizations on safeTransferFrom too", async () => {
    await inft.authorizeUsage(1, executor.address, PERMS);
    await inft["safeTransferFrom(address,address,uint256)"](owner.address, buyer.address, 1);
    expect(await inft.isAuthorized(1, executor.address)).to.equal(false);
  });

  it("lets the new owner grant fresh authorizations after transfer", async () => {
    await inft.authorizeUsage(1, executor.address, PERMS);
    await inft.transferFrom(owner.address, buyer.address, 1);
    expect(await inft.isAuthorized(1, executor.address)).to.equal(false);

    await inft.connect(buyer).authorizeUsage(1, executor.address, "0x5678");
    expect(await inft.isAuthorized(1, executor.address)).to.equal(true);
    expect(await inft.getAuthorization(1, executor.address)).to.equal("0x5678");
  });

  it("does not affect a freshly minted token (mint is not a transfer)", async () => {
    await inft.mint(owner.address, "ipfs://meta2", ethers.ZeroHash); // tokenId 2
    await inft.authorizeUsage(2, executor.address, PERMS);
    expect(await inft.isAuthorized(2, executor.address)).to.equal(true);
  });
});
