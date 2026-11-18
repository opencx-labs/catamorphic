import assert from "node:assert/strict";
import { total } from "../src/total.js";

assert.equal(total([{ amount: 2 }, { amount: 3 }]), 5);
console.log("tests passed");
