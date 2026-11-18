import assert from "node:assert/strict";
import { total } from "../src/total.js";
import { probe } from "./probe.js";

await probe();
assert.equal(total([{ amount: 2 }, { amount: "3.5" }, { amount: null }]), 550);
console.log("tests passed");
