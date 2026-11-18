import assert from "node:assert/strict";
import { total } from "../src/total.js";
import { probe } from "./probe.js";

await probe();
assert.equal(total([{ amount: 2 }, { amount: "3" }, { amount: null }]), 5);
console.log("tests passed");
