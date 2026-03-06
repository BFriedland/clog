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
      { id: "abc123-full-uuid", title: "Fix auth bug", type: "added" },
      { id: "def456-full-uuid", title: "Refactor DB", type: "added" },
      { id: "aaa111-full-uuid", title: "Update metadata", type: "updated" },
    ];
    const msg = generateCommitMessage("alice", changes);
    expect(msg).toContain("clog: alice — 2 added, 1 updated");
    expect(msg).toContain("+ abc123 Fix auth bug");
    expect(msg).toContain("~ aaa111 Update metadata");
  });

  it("includes retracted in summary", () => {
    const changes: PushChange[] = [
      { id: "abc123-full-uuid", title: "Fix auth", type: "added" },
      { id: "def456-full-uuid", title: "Removed", type: "retracted" },
    ];
    const msg = generateCommitMessage("bob", changes);
    expect(msg).toContain("1 added, 1 removed");
    expect(msg).toContain("- def456");
  });

  it("handles all change types", () => {
    const changes: PushChange[] = [
      { id: "aaa111-full-uuid", title: "Added", type: "added" },
      { id: "bbb222-full-uuid", title: "Updated", type: "updated" },
      { id: "ccc333-full-uuid", title: "Retracted", type: "retracted" },
    ];
    const msg = generateCommitMessage("alice", changes);
    expect(msg).toContain("1 added, 1 updated, 1 removed");
    expect(msg).toContain("+ aaa111");
    expect(msg).toContain("~ bbb222");
    expect(msg).toContain("- ccc333");
  });
});
