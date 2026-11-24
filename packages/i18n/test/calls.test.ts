import { describe, expect, test } from "bun:test";
import { en, ptBR } from "../src/index";

// The call buttons' tooltip and aria-label: a missing key would show as the raw "call.video" on hover.
describe("call labels", () => {
  test("pt-BR names the two header buttons", () => {
    expect(ptBR.call.audio).toBe("Ligação de voz");
    expect(ptBR.call.video).toBe("Ligação de vídeo");
  });
  test("every call key in English exists in pt-BR, and none is the raw key", () => {
    for (const key of Object.keys(en.call) as (keyof typeof en.call)[]) {
      expect(typeof ptBR.call[key]).toBe("string");
      expect(ptBR.call[key]).not.toBe(`call.${key}`);
    }
  });
});
