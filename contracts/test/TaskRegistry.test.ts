import { expect } from "chai";
import { ethers, upgrades } from "../lib/hh.js";
import type { TaskRegistry } from "../types/ethers-contracts/index.js";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types";

describe("TaskRegistry", function () {
  let registry: TaskRegistry;
  let admin: HardhatEthersSigner;
  let escrow: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  beforeEach(async function () {
    [admin, escrow, stranger] = await ethers.getSigners();

    const Registry = await ethers.getContractFactory("TaskRegistry");
    registry = (await upgrades.deployProxy(Registry, [], { kind: "uups" })) as unknown as TaskRegistry;

    await registry.connect(admin).authorizePublisher(escrow.address);
  });

  describe("publishTask", function () {
    it("should publish a task and increment counter", async function () {
      const tx = await registry.connect(escrow).publishTask(
        1, escrow.address, "photography", "Lagos, Nigeria", ethers.parseUnits("100", 6)
      );

      expect(await registry.totalTasks()).to.equal(1);
      expect(await registry.openTaskCount()).to.equal(1);
      expect(await registry.taskExists(1)).to.be.true;

      await expect(tx).to.emit(registry, "TaskPublished")
        .withArgs(1, escrow.address, "photography", "Lagos, Nigeria", ethers.parseUnits("100", 6));
    });

    it("should reject duplicate taskId", async function () {
      await registry.connect(escrow).publishTask(1, escrow.address, "photo", "Lagos", 100);
      await expect(
        registry.connect(escrow).publishTask(1, escrow.address, "video", "Nairobi", 200)
      ).to.be.revertedWithCustomError(registry, "TaskAlreadyExists");
    });

    it("should reject unauthorized publisher", async function () {
      await expect(
        registry.connect(stranger).publishTask(1, stranger.address, "test", "test", 100)
      ).to.be.revertedWithCustomError(registry, "NotAuthorized");
    });
  });

  describe("closeTask", function () {
    beforeEach(async function () {
      await registry.connect(escrow).publishTask(1, escrow.address, "photo", "Lagos", 100);
    });

    it("should close an open task and decrement counter", async function () {
      const tx = await registry.connect(escrow).closeTask(1);

      await expect(tx).to.emit(registry, "TaskClosed").withArgs(1);
      expect(await registry.openTaskCount()).to.equal(0);

      const open = await registry.getOpenTasks(0, 10);
      expect(open.length).to.equal(0);
    });

    it("should reject closing non-existent task (prevents default-value bug)", async function () {
      await expect(
        registry.connect(escrow).closeTask(999)
      ).to.be.revertedWithCustomError(registry, "TaskNotFound");
    });

    it("should reject closing already-closed task", async function () {
      await registry.connect(escrow).closeTask(1);
      await expect(
        registry.connect(escrow).closeTask(1)
      ).to.be.revertedWithCustomError(registry, "TaskAlreadyClosed");
    });

    it("should reject unauthorized close", async function () {
      await expect(
        registry.connect(stranger).closeTask(1)
      ).to.be.revertedWithCustomError(registry, "NotAuthorized");
    });
  });

  describe("getOpenTasks", function () {
    beforeEach(async function () {
      await registry.connect(escrow).publishTask(1, escrow.address, "photo", "Lagos", 100);
      await registry.connect(escrow).publishTask(2, escrow.address, "verify", "Nairobi", 200);
      await registry.connect(escrow).publishTask(3, escrow.address, "survey", "Accra", 300);
    });

    it("should return all open tasks", async function () {
      const tasks = await registry.getOpenTasks(0, 10);
      expect(tasks.length).to.equal(3);
      expect(tasks[0].category).to.equal("photo");
      expect(tasks[2].category).to.equal("survey");
    });

    it("should paginate with offset and limit", async function () {
      const page = await registry.getOpenTasks(1, 1);
      expect(page.length).to.equal(1);
      expect(page[0].category).to.equal("verify");
    });

    it("should skip closed tasks", async function () {
      await registry.connect(escrow).closeTask(2);

      const tasks = await registry.getOpenTasks(0, 10);
      expect(tasks.length).to.equal(2);
      expect(tasks[0].category).to.equal("photo");
      expect(tasks[1].category).to.equal("survey");
    });

    it("should return empty for offset beyond count", async function () {
      const tasks = await registry.getOpenTasks(10, 5);
      expect(tasks.length).to.equal(0);
    });
  });

  describe("getTaskMeta", function () {
    it("should return metadata by taskId", async function () {
      await registry.connect(escrow).publishTask(42, escrow.address, "photo", "Lagos", 100);

      const meta = await registry.getTaskMeta(42);
      expect(meta.taskId).to.equal(42);
      expect(meta.category).to.equal("photo");
    });

    it("should reject non-existent taskId", async function () {
      await expect(
        registry.getTaskMeta(999)
      ).to.be.revertedWithCustomError(registry, "TaskNotFound");
    });
  });

  describe("admin functions", function () {
    it("should authorize and revoke publishers with events", async function () {
      await expect(registry.connect(admin).authorizePublisher(stranger.address))
        .to.emit(registry, "PublisherAuthorized").withArgs(stranger.address);

      await registry.connect(stranger).publishTask(99, stranger.address, "x", "y", 1);
      expect(await registry.totalTasks()).to.equal(1);

      await expect(registry.connect(admin).revokePublisher(stranger.address))
        .to.emit(registry, "PublisherRevoked").withArgs(stranger.address);

      await expect(
        registry.connect(stranger).publishTask(100, stranger.address, "a", "b", 2)
      ).to.be.revertedWithCustomError(registry, "NotAuthorized");
    });

    it("should reject authorizing zero address", async function () {
      await expect(
        registry.connect(admin).authorizePublisher(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(registry, "ZeroAddress");
    });

    it("should reject non-admin", async function () {
      await expect(
        registry.connect(stranger).authorizePublisher(stranger.address)
      ).to.be.revertedWithCustomError(registry, "NotAdmin");
    });
  });

  describe("admin transfer", function () {
    it("should transfer via propose + accept", async function () {
      await expect(registry.connect(admin).proposeAdmin(stranger.address))
        .to.emit(registry, "AdminTransferProposed");

      await expect(registry.connect(stranger).acceptAdmin())
        .to.emit(registry, "AdminTransferCompleted");

      expect(await registry.admin()).to.equal(stranger.address);
    });

    it("should reject accept from wrong address", async function () {
      await registry.connect(admin).proposeAdmin(stranger.address);
      await expect(
        registry.connect(escrow).acceptAdmin()
      ).to.be.revertedWithCustomError(registry, "NotPendingAdmin");
    });
  });

  describe("pause", function () {
    it("should block publishing when paused", async function () {
      await registry.connect(admin).pause();
      await expect(
        registry.connect(escrow).publishTask(1, escrow.address, "test", "test", 100)
      ).to.be.revertedWithCustomError(registry, "EnforcedPause");
    });

    it("should allow after unpause", async function () {
      await registry.connect(admin).pause();
      await registry.connect(admin).unpause();
      await expect(
        registry.connect(escrow).publishTask(1, escrow.address, "test", "test", 100)
      ).to.not.revert(ethers);
    });
  });
});
