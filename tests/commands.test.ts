import { describe, expect, test } from "bun:test";
import { acceptCommand, commandPrefix, filterCommands } from "../ui/commands";
import type { CmdInfo } from "../server/proto";

const cmd = (name: string, hint = ""): CmdInfo => ({ name, description: `${name} desc`, argumentHint: hint });

describe("commandPrefix", () => {
  test("only the leading /word is command territory", () => {
    expect(commandPrefix("/")).toBe("");
    expect(commandPrefix("/cle")).toBe("cle");
    expect(commandPrefix("/model ")).toBeNull();      // arguments started — menu closes
    expect(commandPrefix("run /clear")).toBeNull();   // slash mid-sentence
    expect(commandPrefix("hello")).toBeNull();
  });
});

describe("filterCommands", () => {
  const cmds = [cmd("/compact"), cmd("/clear"), cmd("/context"), cmd("/vim"), cmd("/model", "[name]")];

  test("exact beats prefix beats substring; shorter first", () => {
    const names = filterCommands(cmds, "c").map((c) => c.name);
    expect(names).toEqual(["/clear", "/compact", "/context"]);
    expect(filterCommands(cmds, "clear")[0].name).toBe("/clear");
    expect(filterCommands(cmds, "ode").map((c) => c.name)).toEqual(["/model"]);
  });

  test("empty prefix lists everything (capped); no match lists nothing", () => {
    expect(filterCommands(cmds, "").length).toBe(5);
    expect(filterCommands(cmds, "zzz")).toEqual([]);
  });
});

describe("acceptCommand", () => {
  test("appends a space only when the command takes arguments", () => {
    expect(acceptCommand(cmd("/clear"))).toBe("/clear");
    expect(acceptCommand(cmd("/model", "[name]"))).toBe("/model ");
    expect(acceptCommand(cmd("statusline"))).toBe("/statusline");
  });
});
