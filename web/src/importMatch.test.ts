import { describe, expect, it } from "vitest";
import { matchColumns } from "./importMatch";

describe("matchColumns", () => {
  const targets = ["id", "Name", "email", "created_at"];

  it("matches by name ignoring case, leaving unknown sources unmatched", () => {
    expect(matchColumns(["NAME", "ID", "phone"], targets, "name")).toEqual(["Name", "id", null]);
  });

  it("matches by position, as many as there are targets", () => {
    expect(matchColumns(["a", "b", "c", "d", "e"], targets, "order")).toEqual(["id", "Name", "email", "created_at", null]);
  });

  it("matches by name first, then the rest by position among the free targets", () => {
    // "email" takes its own column; "x" falls to position 0, "y" would take
    // position 2 but email is taken, so it stays unmatched.
    expect(matchColumns(["x", "email", "y"], targets, "nameOrder")).toEqual(["id", "email", null]);
  });

  it("gives a target to only one source", () => {
    expect(matchColumns(["id", "ID"], targets, "name")).toEqual(["id", null]);
    expect(matchColumns(["email", "b"], ["b", "email"], "nameOrder")).toEqual(["email", "b"]);
  });
});
