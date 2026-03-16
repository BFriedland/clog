import { generateCommitMessage, type PushChange } from "../src/sync/push.js";

describe("generateCommitMessage", () => {
  it("generates single-line for >10 changes", () => {
    const changes: PushChange[] = [];
    for (let i = 0; i < 15; i++) {
      changes.push({ id: `id-${i}`, title: `Conv ${i}`, type: "added" });
    }
    const msg = generateCommitMessage("alice", changes);
    expect(msg).toBe("clog: alice — 15 added");
    expect(msg.split("\n").length).toBe(1);
  });

  it("generates detailed output for <=10 changes", () => {
    const changes: PushChange[] = [
      { id: "abc1234-full-uuid", title: "Fix auth bug", type: "added" },
      { id: "def4567-full-uuid", title: "Refactor DB", type: "added" },
      { id: "aaa1112-full-uuid", title: "Update metadata", type: "updated" },
    ];
    const msg = generateCommitMessage("alice", changes);
    expect(msg).toContain("clog: alice — 2 added, 1 updated");
    expect(msg).toContain("+ abc1234 Fix auth bug");
    expect(msg).toContain("~ aaa1112 Update metadata");
  });

  it("includes retracted in summary", () => {
    const changes: PushChange[] = [
      { id: "abc1234-full-uuid", title: "Fix auth", type: "added" },
      { id: "def4567-full-uuid", title: "Removed", type: "retracted" },
    ];
    const msg = generateCommitMessage("bob", changes);
    expect(msg).toContain("1 added, 1 removed");
    expect(msg).toContain("- def4567");
  });

  it("handles all change types", () => {
    const changes: PushChange[] = [
      { id: "aaa1112-full-uuid", title: "Added", type: "added" },
      { id: "bbb2223-full-uuid", title: "Updated", type: "updated" },
      { id: "ccc3334-full-uuid", title: "Retracted", type: "retracted" },
    ];
    const msg = generateCommitMessage("alice", changes);
    expect(msg).toContain("1 added, 1 updated, 1 removed");
    expect(msg).toContain("+ aaa1112");
    expect(msg).toContain("~ bbb2223");
    expect(msg).toContain("- ccc3334");
  });
});
