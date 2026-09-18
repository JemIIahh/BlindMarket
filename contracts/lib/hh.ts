/**
 * Hardhat 3 no longer exports `ethers`, `upgrades` or `network` from
 * "hardhat": they come from a network connection. Tests and scripts import
 * them from here instead, so there is exactly one connection per process —
 * the OpenZeppelin upgrades plugin requires deploys and upgrades to share
 * one, and the tests rely on shared chain state as they did under Hardhat 2.
 *
 * `hardhat run <script> --network <name>` selects the network; with no flag
 * this is the in-process simulated chain the tests use.
 */
import hre from "hardhat";
import { upgrades as createUpgrades } from "@openzeppelin/hardhat-upgrades";

const connection = await hre.network.create();

export const ethers = connection.ethers;
export const upgrades = await createUpgrades(hre, connection);
export const time = connection.networkHelpers.time;
/** Hardhat 2's `network.name` / `network.provider`, which the scripts log and the AA test drives. */
export const network = { name: connection.networkName, provider: connection.provider };
