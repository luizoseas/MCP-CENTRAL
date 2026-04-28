import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  escapeLdapFilterValue,
  resolveDirectBindIdentity,
  upnDomainFromBaseDn,
} from "./ldapAuth.js";

describe("escapeLdapFilterValue", () => {
  it("escapa meta-caracteres RFC4515", () => {
    assert.equal(escapeLdapFilterValue("a*b"), "a\\2ab");
    assert.equal(escapeLdapFilterValue("u(s)er"), "u\\28s\\29er");
    assert.equal(escapeLdapFilterValue("x\\y"), "x\\5cy");
  });
});

describe("upnDomainFromBaseDn", () => {
  it("concatena DC= na ordem do DN", () => {
    assert.equal(
      upnDomainFromBaseDn("OU=Usuarios,DC=eship,DC=local"),
      "eship.local",
    );
    assert.equal(upnDomainFromBaseDn("DC=corp,DC=acme,DC=com"), "corp.acme.com");
  });
  it("devolve null se não houver DC=", () => {
    assert.equal(upnDomainFromBaseDn("OU=Only,OU=Here"), null);
  });
});

describe("resolveDirectBindIdentity", () => {
  it("substitui {{username}} no modelo", () => {
    assert.equal(
      resolveDirectBindIdentity("{{username}}@eship.local", "jdoe"),
      "jdoe@eship.local",
    );
  });
  it("usa o valor literal quando já é UPN ou DN", () => {
    assert.equal(
      resolveDirectBindIdentity("{{username}}@x.y", "a@b.c"),
      "a@b.c",
    );
    assert.equal(
      resolveDirectBindIdentity("{{username}}@x.y", "CN=Svc,DC=x,DC=y"),
      "CN=Svc,DC=x,DC=y",
    );
    assert.equal(
      resolveDirectBindIdentity("{{username}}@x.y", "DOM\\user"),
      "DOM\\user",
    );
  });
});
