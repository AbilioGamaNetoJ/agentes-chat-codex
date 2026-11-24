import { describe, expect, test } from "bun:test";
import { en, ptBR } from "../src/index";
import { flatten } from "./check-locale";

describe("call strings", () => {
  test("the call buttons read as words in pt-BR, not as keys", () => {
    expect(ptBR.call.audio).toBe("Ligação de voz");
    expect(ptBR.call.video).toBe("Ligação de vídeo");
  });
  test("pt-BR holds every call key of English, none left as its own key", () => {
    const keys = flatten(en.call).map(([k]) => k);
    expect(
      flatten(ptBR.call)
        .map(([k]) => k)
        .sort(),
    ).toEqual(keys.sort());
    for (const [, v] of flatten(ptBR.call)) expect(v).not.toMatch(/^call\./);
  });
});
