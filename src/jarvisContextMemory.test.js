import { describe, expect, it } from "vitest";
import {
  answerFromContextMemory,
  looksLikeRecentPcFileLocationQuestion,
} from "./jarvisContextMemory.js";

const memory = {
  recentPcFiles: [{
    filename: "old.md",
    path: "/tmp/pc-workspace/old.md",
    workspaceRoot: "/tmp/pc-workspace",
  }],
};

describe("Jarvis context memory intent boundaries", () => {
  it("answers explicit follow-up questions about a previous file location", () => {
    expect(looksLikeRecentPcFileLocationQuestion("刚才创建的文件在哪里？")).toBe(true);
    expect(looksLikeRecentPcFileLocationQuestion("你把刚才的文件保存在哪里了？")).toBe(true);
    expect(looksLikeRecentPcFileLocationQuestion("能告诉我 old.md 的完整路径吗？")).toBe(true);
    expect(answerFromContextMemory(memory, "刚才的文件目录是哪个？")).toMatchObject({
      handled: true,
      type: "pc_file_location",
      item: { filename: "old.md" },
    });
  });

  it("does not consume a new file action just because it mentions the PC workspace", () => {
    const request = "请在电脑工作区新建 jarvis-container-e2e.md，并写入 helloworld。";
    expect(looksLikeRecentPcFileLocationQuestion(request)).toBe(false);
    expect(answerFromContextMemory(memory, request)).toBeNull();
  });

  it.each([
    "把文件存哪？然后再创建一个副本",
    "刚才文件在哪里，再写入一行",
    "刚才文件路径是什么？顺便打开它",
    "复制一份，然后告诉我刚才文件在哪里",
    "刚才保存的文件在哪，同时把它重命名为 final.md",
    "请告诉我文件路径并删除它",
    "刚才文件在哪里，不要修改它",
  ])("does not consume a mixed location query and file action: %s", (request) => {
    expect(looksLikeRecentPcFileLocationQuestion(request)).toBe(false);
    expect(answerFromContextMemory(memory, request)).toBeNull();
  });

  it.each([
    "刚才文件在哪里",
    "刚才创建的文件在哪里",
    "你把刚才的文件保存在哪里了",
    "刚才文件在哪个目录",
    "能告诉我 old.md 的完整路径吗",
  ])("keeps pure location questions on the context shortcut: %s", (request) => {
    expect(looksLikeRecentPcFileLocationQuestion(request)).toBe(true);
    expect(answerFromContextMemory(memory, request)).toMatchObject({
      handled: true,
      type: "pc_file_location",
    });
  });
});
