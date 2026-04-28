import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { escapeLdapFilterValue } from "./ldapAuth.js";

describe("escapeLdapFilterValue", () => {
  it("escapa meta-caracteres RFC4515", () => {
    assert.equal(escapeLdapFilterValue("a*b"), "a\\2ab");
    assert.equal(escapeLdapFilterValue("u(s)er"), "u\\28s\\29er");
    assert.equal(escapeLdapFilterValue("x\\y"), "x\\5cy");
  });
});
