import { expect } from "chai";
import { readFileSync } from "node:fs";
import path from "node:path";
import hre from "hardhat";
import { ethers } from "../lib/hh.js";
import {
  assertUpgradeSafe,
  getStorageLayout,
  getStorageUpgradeReport,
  getVersion,
  isCurrentValidationData,
  withValidationDefaults,
  type StorageLayout,
  type ValidationDataCurrent,
} from "@openzeppelin/upgrades-core";

/**
 * The compiled BlindEscrow must stay a safe UUPS upgrade of the implementation
 * each live proxy runs. The deployed layout comes from the OpenZeppelin network
 * manifest committed for that chain, so this runs offline, on every test run,
 * with no RPC. scripts/validate-escrow-upgrade.ts is the live check before an
 * actual upgrade.
 */
const DEPLOYED = [
  { chain: "Arc mainnet", manifest: ".openzeppelin/unknown-5042.json", proxy: "0xd2B819B57a9568Cb6bFc98C687F9a851EC8330C4" },
  { chain: "Arc testnet", manifest: ".openzeppelin/unknown-5042002.json", proxy: "0xaBf70843E0380F1e749d2b85C30dD6820Ff5C731" },
];

/**
 * State this BlindEscrow appends after the deployed implementations' last
 * variable (minRatedAmount, slot 17): open submission. Append-only, so the
 * deployed variables keep their slots and these take the next ones.
 */
const APPENDED = [
  "18:0:_openTasks:t_mapping(t_uint256,t_struct(OpenTask)_storage)",
  "19:0:submissionCount:t_mapping(t_uint256,t_uint256)",
  "20:0:submissionOf:t_mapping(t_uint256,t_mapping(t_address,t_bytes32))",
  "21:0:scorecardOf:t_mapping(t_uint256,t_bytes32)",
];

type Manifest = {
  proxies: Array<{ address: string; kind: string }>;
  impls: Record<string, { address: string; layout: StorageLayout; txHash?: string }>;
};

/** The implementation the manifest records last: the one the proxy was most recently pointed at. */
function deployedLayout(path: string): { address: string; layout: StorageLayout } {
  const manifest = JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8")) as Manifest;
  const impls = Object.values(manifest.impls);
  const latest = impls[impls.length - 1];
  return { address: latest.address, layout: latest.layout };
}

// Type ids carry the compiler's AST node id (t_contract(ITaskRegistry)22865),
// which moves whenever any source file changes; the layout does not.
const normalize = (type: string) => type.replace(/\)\d+(_storage)?/g, ")$1");
const shape = (l: StorageLayout) => l.storage.map((s) => `${s.slot}:${s.offset}:${s.label}:${normalize(s.type)}`);
function taskMembers(l: StorageLayout): string[] {
  const key = Object.keys(l.types).find((k) => /^t_struct\(Task\)\d+_storage$/.test(k));
  expect(key, "Task struct missing from the layout").to.not.equal(undefined);
  const members = (l.types[key!] as { members?: Array<{ label: string; type: string; offset?: number; slot?: string }> }).members ?? [];
  return members.map((m) => `${m.slot ?? "?"}:${m.offset ?? "?"}:${m.label}:${normalize(m.type)}`);
}

describe("BlindEscrow storage layout vs the deployed implementations", function () {
  let updated: StorageLayout;

  before(async function () {
    // The OpenZeppelin plugin writes its validation data here on every compile
    // (hardhat-upgrades' readValidations reads the same file; the package does
    // not export that helper).
    const validations = JSON.parse(readFileSync(path.join(hre.config.paths.cache, "validations.json"), "utf8")) as ValidationDataCurrent;
    expect(isCurrentValidationData(validations), "OpenZeppelin validations cache is outdated: recompile").to.equal(true);
    const Factory = await ethers.getContractFactory("BlindEscrow");
    const version = getVersion(Factory.bytecode);
    // The implementation itself must be upgrade-safe (UUPS, no unsafe opcodes).
    assertUpgradeSafe(validations, version, withValidationDefaults({ kind: "uups" }));
    updated = getStorageLayout(validations, version);
  });

  for (const target of DEPLOYED) {
    it(`is a compatible upgrade of the ${target.chain} implementation (${target.manifest})`, function () {
      const { layout } = deployedLayout(target.manifest);
      const report = getStorageUpgradeReport(layout, updated, withValidationDefaults({ kind: "uups" }));
      expect(report.ok, report.explain()).to.equal(true);
    });

    it(`keeps every ${target.chain} state variable, and the Task struct, in the same slot, offset and type`, function () {
      const { layout } = deployedLayout(target.manifest);
      expect(shape(updated)).to.deep.equal([...shape(layout), ...APPENDED]);
      expect(taskMembers(updated)).to.deep.equal(taskMembers(layout));
      expect(Object.keys(updated.namespaces ?? {}).sort()).to.deep.equal(Object.keys(layout.namespaces ?? {}).sort());
    });
  }
});
