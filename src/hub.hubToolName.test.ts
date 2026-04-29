import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  HUB_EXPOSED_TOOL_NAME_MAX_LEN,
  hubToolName,
} from "./hub.js";

describe("hubToolName", () => {
  it("mantém nomes curtos inalterados", () => {
    assert.equal(hubToolName("srv", "my_tool"), "srv__my_tool");
  });

  it("limita a 60 caracteres com sufixo _8hex", () => {
    const longServer = "a".repeat(40);
    const longTool = "b".repeat(40);
    const name = hubToolName(longServer, longTool);
    assert.equal(name.length, HUB_EXPOSED_TOOL_NAME_MAX_LEN);
    assert.match(name, /^a+__b+_[0-9a-f]{8}$/);
  });

  it("dois nomes longos distintos não colidem no sufixo (caso típico)", () => {
    const a = hubToolName("x", "tool_" + "y".repeat(50));
    const b = hubToolName("x", "tool_" + "z".repeat(50));
    assert.notEqual(a, b);
  });
});
