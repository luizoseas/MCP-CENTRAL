import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  allocateUniqueHubToolName,
  hubToolName,
} from "./hub.js";

describe("hubToolName", () => {
  it("mantém nomes curtos inalterados", () => {
    assert.equal(hubToolName("srv", "my_tool"), "srv__my_tool");
  });

  it("limita a 60 caracteres com sufixo _8hex (limite explícito)", () => {
    const longServer = "a".repeat(40);
    const longTool = "b".repeat(40);
    const name = hubToolName(longServer, longTool, 60);
    assert.equal(name.length, 60);
    assert.match(name, /^a+__b+_[0-9a-f]{8}$/);
  });

  it("dois nomes longos distintos não colidem no sufixo (caso típico)", () => {
    const a = hubToolName("x", "tool_" + "y".repeat(50));
    const b = hubToolName("x", "tool_" + "z".repeat(50));
    assert.notEqual(a, b);
  });
});

describe("allocateUniqueHubToolName", () => {
  it("desambigua colisão estrutural servidor/tool vs servidor composto", () => {
    const used = new Set<string>();
    const first = allocateUniqueHubToolName("a", "b__c", used);
    const second = allocateUniqueHubToolName("a__b", "c", used);
    assert.equal(first, "a__b__c");
    assert.equal(second, "a__b__c__hubuniq1");
    assert.notEqual(first, second);
  });
});
