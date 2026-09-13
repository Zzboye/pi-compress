# 图片 Turn 降级策略实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 图片在被 ledger 接管的 turn 中不再静默消失——占位符进日志头、摘要模型感知图片、recall 可取回真图。

**Architecture:** 图片元信息寄居在既有 `LedgerQuote`（`images?` 字段，零新 ID 零映射层）；渲染层在 L1–L3 用户消息行后追加占位行（L4 靠摘要描述）；摘要输入链路把 image 块替换为 `[图片: mime]` 文本标记；recall 扩展为文本 + image 块混合 content。Spec：`docs/superpowers/specs/2026-09-12-image-turn-degrade-design.md`。

**Tech Stack:** TypeScript (ESM)、vitest、pi coding-agent 类型（`AgentMessage`、`ImageContent {type:"image", data, mimeType}`）。

## Global Constraints

- 不造合成 ID：占位符 ↩id 一律用既有 entryId（`userMessage.entryId` / 动作 recallIds）
- 占位符 L1–L3 渲染同款，L4 不渲染占位行
- 无图路径行为零变化：`images` 为空/缺省时渲染、序列化、recall 输出与现状逐字节一致
- passthrough / 窗口内图片不在本计划范围（spec §3.5）
- 每个任务 TDD：先红后绿，`npx vitest run <file>` 验证，任务结束 commit
- 全程在 main 分支直接工作（仓库惯例：小特性直推 main）

---

### Task 1: extractUserMessage 提取图片元信息

**Files:**
- Modify: `src/ledger.ts:19`（LedgerQuote 接口）
- Modify: `src/util.ts`（extractUserMessage 及其辅助）
- Test: `tests/util-extract.test.ts`

**Interfaces:**
- Consumes: 现有 `MessageEntry`/`Turn`（util.ts）、`LedgerQuote`（ledger.ts）
- Produces: `LedgerQuote` 新增可选字段 `images?: { mimeType: string; bytes: number }[]`；导出新函数 `extractImages(content: unknown): { mimeType: string; bytes: number }[]`（后续任务复用）。`bytes` 估算 = `Math.ceil(data.length * 3 / 4)`（base64 → 字节近似）。

- [ ] **Step 1: 写失败测试**（追加到 `tests/util-extract.test.ts` 末尾的 extractUserMessage describe 块之后，新建 describe）：

```ts
describe("extractImages / extractUserMessage images", () => {
  const img = (mime: string, dataLen: number) => ({ type: "image", mimeType: mime, data: "A".repeat(dataLen) });

  it("extractImages 提取 mimeType 与估算字节", () => {
    const { extractImages } = await import("../src/util.js");
    // 注意：顶部 import 一并加 extractImages，此处直接用导入
  });

  it("extractUserMessage 携带 images 元信息", () => {
    const e: MessageEntry = {
      id: "u-img",
      message: {
        role: "user",
        content: [
          { type: "text", text: "看这个报错" },
          img("image/png", 4800),
          img("image/jpeg", 8000),
        ],
      },
    } as unknown as MessageEntry;
    const q = extractUserMessage(turnOf(e))!;
    expect(q.text).toBe("看这个报错");
    expect(q.entryId).toBe("u-img");
    expect(q.images).toEqual([
      { mimeType: "image/png", bytes: 3600 },
      { mimeType: "image/jpeg", bytes: 6000 },
    ]);
  });

  it("纯文本消息 images 为 undefined（零变化不变式）", () => {
    const q = extractUserMessage(turnOf(userEntry("u-plain", "没有图")))!;
    expect(q.images).toBeUndefined();
  });

  it("无 text 但有图：仍返回 quote（text 空串不成立时才 undefined）——现状 text='' 返回 undefined，图随 turn 丢失", () => {
    // 维持现状：text 为空 → undefined（占位渲染走 userIntent 兜底）。
    // 此用例锁定现状行为，防止实现时意外改变分支条件。
    const e: MessageEntry = { id: "u-only-img", message: { role: "user", content: [img("image/png", 100)] } } as unknown as MessageEntry;
    expect(extractUserMessage(turnOf(e))).toBeUndefined();
  });
});
```

注意：第一个用例写成可执行形式（顶部 import 加 `extractImages`）：

```ts
it("extractImages 提取 mimeType 与估算字节", () => {
  const blocks = [img("image/png", 4800), { type: "text", text: "x" }];
  expect(extractImages(blocks)).toEqual([{ mimeType: "image/png", bytes: 3600 }]);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/util-extract.test.ts`
Expected: FAIL——`extractImages` 未导出、`images` 字段不存在

- [ ] **Step 3: 最小实现**

`src/ledger.ts:19`：

```ts
export interface LedgerQuote {
  text: string;
  entryId: string;
  /** 用户消息中的图片元信息（仅 userMessage 提取；bytes 为 base64 估算字节） */
  images?: { mimeType: string; bytes: number }[];
}
```

`src/util.ts`（joinedText 附近新增）：

```ts
/** 提取 content 中的图片块元信息；bytes ≈ base64 解码后字节数 */
export function extractImages(content: unknown): { mimeType: string; bytes: number }[] {
  if (!Array.isArray(content)) return [];
  const out: { mimeType: string; bytes: number }[] = [];
  for (const b of content) {
    if (b?.type === "image" && typeof b.mimeType === "string") {
      out.push({ mimeType: b.mimeType, bytes: Math.ceil((b.data?.length ?? 0) * 3 / 4) });
    }
  }
  return out;
}
```

`extractUserMessage` 返回值扩展：

```ts
export function extractUserMessage(turn: Turn): LedgerQuote | undefined {
  const first = turn.entries[0];
  if (!first || first.message.role !== "user") return undefined;
  const text = joinedText((first.message as any).content);
  if (text === "") return undefined;
  const images = extractImages((first.message as any).content);
  return { text, entryId: first.id, ...(images.length > 0 ? { images } : {}) };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/util-extract.test.ts`
Expected: PASS（全部）

- [ ] **Step 5: Commit**

```bash
git add src/ledger.ts src/util.ts tests/util-extract.test.ts
git commit -m "feat: extractUserMessage 提取图片元信息（LedgerQuote.images）"
```

---

### Task 2: L1–L3 占位行渲染

**Files:**
- Modify: `src/ledger.ts`（renderTurnText + 新增 renderImagesLine + turnRenderTokens 无需改动说明验证）
- Test: `tests/ledger.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `LedgerQuote.images`
- Produces: 导出 `renderImagesLine(l: LedgerData): string | undefined`——有图时返回 `[图片 ×N: mime1, mime2 ↩<entryId>]`（N>2 时 mime 列表截断为前 2 个 + `…`），无图返回 undefined。`renderTurnText` 在 L1–L3 的用户消息行（或用户意图行）之后插入该行；L4 在渲染分支最前 return 前不加。`turnRenderTokens` 基于 `renderTurnText` 体积计算，占位行自动计入，无需改动。

- [ ] **Step 1: 写失败测试**（追加到 tests/ledger.test.ts，fixture 构造参照文件内既有 mkL1 模式；本任务测试独立构造带 images 的 LedgerData）：

```ts
describe("图片占位行", () => {
  const withImgs = (level: 1 | 2 | 3 | 4, imgs?: { mimeType: string; bytes: number }[]): LedgerData => ({
    turnStartEntryId: "u1", turnEndEntryId: "a1", level,
    summary: { userIntent: "看报错", outcome: "ok", entries: [] },
    userMessage: { text: "帮我看下这个报错", entryId: "u1", ...(imgs ? { images: imgs } : {}) },
    finalReply: { text: "好的", entryId: "a1" },
    ...(level === 4 ? { merged: { description: "调试会话" } } : {}),
  } as LedgerData);

  it("L1 用户消息行后渲染占位行，↩ 指向 userMessage.entryId", () => {
    const out = renderTurnText(withImgs(1, [{ mimeType: "image/png", bytes: 100 }, { mimeType: "image/png", bytes: 100 }]), 7);
    expect(out).toContain("[图片 ×2: image/png, image/png ↩u1]");
    // 占位行在用户消息行之后、动作行之前
    const iUser = out.indexOf("### T7");
    const iImg = out.indexOf("[图片 ×2");
    expect(iImg).toBeGreaterThan(iUser);
  });

  it("单图渲染", () => {
    const out = renderTurnText(withImgs(2, [{ mimeType: "image/jpeg", bytes: 100 }]), 3);
    expect(out).toContain("[图片 ×1: image/jpeg ↩u1]");
  });

  it("超过 2 张：mime 列表截断为前两个 + …", () => {
    const imgs = Array.from({ length: 4 }, () => ({ mimeType: "image/png", bytes: 1 }));
    const out = renderTurnText(withImgs(1, imgs), 1);
    expect(out).toContain("[图片 ×4: image/png, image/png … ↩u1]");
  });

  it("L2/L3 同样渲染占位行", () => {
    expect(renderTurnText(withImgs(2, [{ mimeType: "image/png", bytes: 1 }]), 2)).toContain("[图片 ×1");
    expect(renderTurnText(withImgs(3, [{ mimeType: "image/png", bytes: 1 }]), 2)).toContain("[图片 ×1");
  });

  it("L4 不渲染占位行", () => {
    const out = renderTurnText(withImgs(4, [{ mimeType: "image/png", bytes: 1 }]), 5);
    expect(out).not.toContain("[图片");
    expect(out).toContain("调试会话");
  });

  it("无图：不渲染占位行（零变化不变式）", () => {
    expect(renderTurnText(withImgs(1), 1)).not.toContain("[图片");
  });

  it("占位行计入 turnRenderTokens", async () => {
    const { turnRenderTokens } = await import("../src/degrade.js");
    const noImg = turnRenderTokens(withImgs(1) as any, 0);
    const hasImg = turnRenderTokens(withImgs(1, [{ mimeType: "image/png", bytes: 1 }]) as any, 0);
    expect(hasImg).toBeGreaterThan(noImg);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/ledger.test.ts`
Expected: FAIL——无占位行渲染

- [ ] **Step 3: 最小实现**

`src/ledger.ts`（renderTurnText 上方新增）：

```ts
/** 图片占位行：L1–L3 渲染在用户消息行后；L4 不渲染（图片存在感靠摘要描述）。↩ 复用 userMessage.entryId */
export function renderImagesLine(l: LedgerData): string | undefined {
  const imgs = l.userMessage?.images;
  if (!imgs || imgs.length === 0) return undefined;
  const mimes = imgs.slice(0, 2).map((i) => i.mimeType).join(", ") + (imgs.length > 2 ? " …" : "");
  return `[图片 ×${imgs.length}: ${mimes} ↩${l.userMessage!.entryId}]`;
}
```

`renderTurnText` 在用户行之后、动作行循环之前插入（L4 分支在最前 return，天然不受影响）：

```ts
  // ...用户行 push 之后：
  const imagesLine = renderImagesLine(l);
  if (imagesLine) lines.push(imagesLine);
```

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `npx vitest run tests/ledger.test.ts && npx vitest run tests/degrade.test.ts tests/recall.test.ts`
Expected: PASS（recall/searchLedger 不受影响；degrade 渲染口径自动含占位行）

- [ ] **Step 5: Commit**

```bash
git add src/ledger.ts tests/ledger.test.ts
git commit -m "feat: L1–L3 动作日志渲染图片占位行（↩ 复用 userMessage.entryId）"
```

---

### Task 3: 摘要输入的图片文本标记

**Files:**
- Modify: `src/util.ts`（serializeTurn 链路新增 imageToTextMarkers）
- Test: `tests/util-extract.test.ts`

**Interfaces:**
- Consumes: 现有 `serializeTurn(turn)` 签名不变
- Produces: 序列化前 image 块被替换为文本块 `[图片: <mimeType>]`。摘要模型（summarizer.ts 无需改动，走 serializeTurn）自动感知。注意替换发生在 `convertToLlm` 之前，user 与 toolResult 角色的 content 数组都处理。

- [ ] **Step 1: 写失败测试**（追加到 tests/util-extract.test.ts 新 describe）：

```ts
describe("serializeTurn 图片标记", () => {
  it("user content 中的 image 块替换为 [图片: mime] 文本", () => {
    const { serializeTurn } = await import("../src/util.js"); // 顶部 import 加 serializeTurn
  });

  it("toolResult content 中的 image 块同样替换", () => {
    // 同款断言，role: "toolResult"
  });

  it("无图 turn 输出与旧实现逐字节一致", () => {
    // fixture：纯文本 turn，快照对比（实现前后各跑一次记录基线）
  });
});
```

可执行形式：

```ts
it("user content 中的 image 块替换为 [图片: mime] 文本", () => {
  const entries: MessageEntry[] = [
    { id: "u1", message: { role: "user", content: [{ type: "text", text: "看图" }, { type: "image", mimeType: "image/png", data: "AAAA" }] } } as unknown as MessageEntry,
    { id: "a1", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } } as unknown as MessageEntry,
  ];
  const out = serializeTurn({ startEntryId: "u1", endEntryId: "a1", entries });
  expect(out).toContain("[图片: image/png]");
  expect(out).toContain("看图");
  expect(out).not.toContain("AAAA");
});

it("toolResult content 中的 image 块同样替换", () => {
  const entries: MessageEntry[] = [
    { id: "u1", message: { role: "user", content: [{ type: "text", text: "截个图" }] } } as unknown as MessageEntry,
    { id: "a1", message: { role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "shot", arguments: {} }] } } as unknown as MessageEntry,
    { id: "r1", message: { role: "toolResult", toolCallId: "tc1", toolName: "shot", content: [{ type: "image", mimeType: "image/png", data: "BBBB" }] } } as unknown as MessageEntry,
  ];
  const out = serializeTurn({ startEntryId: "u1", endEntryId: "r1", entries });
  expect(out).toContain("[图片: image/png]");
  expect(out).not.toContain("BBBB");
});

it("无图 turn 输出不含标记（零变化）", () => {
  const entries: MessageEntry[] = [
    { id: "u1", message: { role: "user", content: [{ type: "text", text: "纯文本" }] } } as unknown as MessageEntry,
  ];
  expect(serializeTurn({ startEntryId: "u1", endEntryId: "u1", entries })).not.toContain("[图片");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/util-extract.test.ts`
Expected: FAIL——`[图片:` 未出现

- [ ] **Step 3: 最小实现**

`src/util.ts`，在 serializeTurn 链路中加一步（stripThinking 之后、convertToLlm 之前）：

```ts
/** image 块 → 文本标记：摘要模型不可见图（serializeConversation 只取 text），替换为标记保留存在感 */
function imageToTextMarkers(entries: MessageEntry[]): MessageEntry[] {
  return entries.map((e) => {
    const content = (e.message as any).content;
    if (!Array.isArray(content) || !content.some((b: any) => b?.type === "image")) return e;
    const mapped = content.map((b: any) =>
      b?.type === "image" ? { type: "text", text: `[图片: ${b.mimeType ?? "unknown"}]` } : b,
    );
    return { ...e, message: { ...(e.message as any), content: mapped } } as MessageEntry;
  });
}

export function serializeTurn(turn: Turn): string {
  return serializeConversation(
    convertToLlm(stripThinking(imageToTextMarkers(preTruncateToolResults(turn.entries)))).map((e) => e.message) as any,
  );
}
```

- [ ] **Step 4: 跑测试确认通过 + 摘要器回归**

Run: `npx vitest run tests/util-extract.test.ts tests/summarizer.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/util.ts tests/util-extract.test.ts
git commit -m "feat: 摘要输入链路 image 块替换为 [图片: mime] 文本标记"
```

---

### Task 4: recall 返回真图

**Files:**
- Modify: `src/recall.ts`（RecallResult + executeRecall + executeRecallDual）
- Modify: `src/index.ts`（recall 工具 execute 组装混合 content）
- Test: `tests/recall.test.ts`、`tests/extension.test.ts`

**Interfaces:**
- Consumes: 现有 `executeRecall(ids, branch, maxTokensPerEntry)` 签名不变；pi 的 `ImageContent { type: "image", data, mimeType }`
- Produces: `RecallResult` 新增 `images: { block: { type: "image"; data: string; mimeType: string }; sourceId: string }[]`（block 即 pi 工具结果可用的 image content 块，sourceId 为来源 entry ID 供文本提示）。`executeRecall` 收集命中 entry 自身 content 及其配对 toolResult content 中的 image 块；文本提示行 `[含图片 ×N，已附在结果中]` 加入该 entry 的文本段。`executeRecallDual` 透传 images。`index.ts` recall 工具：`content: [{ type: "text", text }, ...r.images.map((i) => i.block)]`（仅 ids 模式；query 模式无图）。notes 分支不产图。

- [ ] **Step 1: 写失败测试**（追加到 tests/recall.test.ts）：

```ts
describe("recall 返回图片", () => {
  const pngBlock = { type: "image", mimeType: "image/png", data: "AAAA" };
  const jpegBlock = { type: "image", mimeType: "image/jpeg", data: "BBBB" };

  const imgBranch: MessageEntry[] = [
    { id: "u1", message: { role: "user", content: [{ type: "text", text: "看图" }, pngBlock] } } as unknown as MessageEntry,
    { id: "a1", message: { role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "shot", arguments: {} }] } } as unknown as MessageEntry,
    { id: "r1", message: { role: "toolResult", toolCallId: "tc1", toolName: "shot", content: [{ type: "text", text: "截图完成" }, jpegBlock] } } as unknown as MessageEntry,
  ];

  it("命中含图 entry：images 收集自身 content 的图 + 文本提示", () => {
    const r = executeRecall(["u1"], imgBranch, 4000);
    expect(r.images).toEqual([{ block: pngBlock, sourceId: "u1" }]);
    expect(r.text).toContain("[含图片 ×1，已附在结果中]");
  });

  it("recall toolCall entry：配对 toolResult 的图一并带回", () => {
    const r = executeRecall(["a1"], imgBranch, 4000);
    expect(r.images).toEqual([{ block: jpegBlock, sourceId: "a1" }]);
    expect(r.text).toContain("[含图片 ×1，已附在结果中]");
  });

  it("多图多源：按命中顺序收集，sourceId 标注来源", () => {
    const r = executeRecall(["u1", "a1"], imgBranch, 4000);
    expect(r.images.map((i) => i.sourceId)).toEqual(["u1", "a1"]);
  });

  it("无图 entry：images 为空数组、文本无提示（零变化）", () => {
    const r = executeRecall(["e1"], branch, 4000);
    expect(r.images).toEqual([]);
    expect(r.text).not.toContain("[含图片");
  });

  it("executeRecallDual 透传 images；notes 命中不产图", () => {
    // notes 分支：用现有测试文件的 NoteStore fixture 模式（参照 mkStore helper）
  });
});
```

第三个 describe（executeRecallDual）可执行形式（沿用文件内既有 helper 风格，NoteStore append 一个条目后召回）：

```ts
it("executeRecallDual 透传 images；notes 命中不产图", () => {
  const store = new NoteStore(join(tmpdir(), `recall-img-${Date.now()}`));
  store.append("prefs", "偏好 X", "细节");
  const r = executeRecallDual(["pref-001", "u1"], imgBranch, store, 4000);
  expect(r.images.map((i) => i.sourceId)).toEqual(["u1"]);
  expect(r.notesHits).toBe(1);
});
```

（NoteStore 构造参数以 tests/notes.test.ts 现有 mkStore helper 为准；若 helper 不导出，按其构造方式内联。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/recall.test.ts`
Expected: FAIL——`r.images` undefined

- [ ] **Step 3: 实现 recall.ts**

```ts
export interface RecallImage { block: { type: "image"; data: string; mimeType: string }; sourceId: string }
export interface RecallResult { text: string; missing: string[]; notesHits: number; images: RecallImage[] }
```

`executeRecall` 内（msgs 组装后）：

```ts
    const imgs: RecallImage[] = [];
    const collectImages = (m: any) => {
      if (Array.isArray(m?.content)) {
        for (const b of m.content) {
          if (b?.type === "image" && typeof b.data === "string") imgs.push({ block: { type: "image", data: b.data, mimeType: b.mimeType ?? "image/png" }, sourceId: id });
        }
      }
    };
    for (const m of msgs) collectImages(m);
    if (imgs.length > 0) {
      text += `\n[含图片 ×${imgs.length}，已附在结果中]`;
    }
```

（text 截断逻辑在图片提示之后——提示加在截断后文本的末尾，保证不被截掉。返回值补 `images: imgs`。）

`executeRecallDual`：notes 分支 images 累积为空；branch 分支 `allImages.push(...r.images)`，返回 `images: allImages`。

- [ ] **Step 4: 修改 index.ts recall 工具返回**

```ts
      if (params.ids && params.ids.length > 0) {
        const r = executeRecallDual(params.ids, entries, notesStore, 4_000);
        recallStats.calls += 1;
        // ...统计不变
        parts.push(r.text);
        if (r.images.length > 0) imageBlocks.push(...r.images.map((i) => i.block));
      }
      // ...
      return {
        content: [
          { type: "text", text: parts.join("\n\n---\n\n") },
          ...imageBlocks,
        ],
        details: undefined,
      };
```

（`const imageBlocks: any[] = []` 在 execute 顶部声明；query-only 时空数组无影响。）

- [ ] **Step 5: 工具级测试**（tests/extension.test.ts，沿用 harness 模式）：

```ts
it("recall 工具返回混合 content（文本 + image 块）", async () => {
  // 构造 branch 含 image 的 user entry → handlers 经由工具注册表调用 tools.recall.execute
  // 断言返回 content 数组长度 ≥2，第二块 type === "image"
});
```

（具体 fixture 复用本文件既有 recall 工具测试的 branch 构造，加一个 image 块即可。）

- [ ] **Step 6: pi 透传验证（风险闸门）**

Run: `npx vitest run tests/extension.test.ts tests/recall.test.ts`
Expected: PASS——单元/工具级均通过。

**人工验证说明**（写入 commit message）：工具结果 image 块能否进入后续 LLM 请求由 pi 核心决定（`pi-agent-core` 消息透传），本仓库无法端到端断言。若实际使用中发现图未进上下文，降级路径已就绪：占位行与文本提示仍在，仅需把 index.ts 的 `...imageBlocks` 移除并改为纯文本说明。此风险记录于 spec §3.4。

- [ ] **Step 7: 全量回归 + Commit**

```bash
npx vitest run 2>&1 | grep -E "Tests |Test Files"
git add src/recall.ts src/index.ts tests/recall.test.ts tests/extension.test.ts
git commit -m "feat: recall 返回真图（混合 content：文本 + image 块，含配对 toolResult 的图）"
```

Expected: 全量 PASS

---

### Task 5: README 同步

**Files:**
- Modify: `README.md`（四级分层小节 + recall 说明处）

**Interfaces:**
- Consumes: Task 1–4 全部交付
- Produces: 文档与实现一致

- [ ] **Step 1: 更新四级分层小节**

L1/L2 行的描述后补充占位行说明；在分层列表后加一行：

```markdown
- **图片**：用户消息中的图片在 L1–L3 渲染占位行 `[图片 ×N: mime ↩entryId]`（不随层级降级——一行字换 1200 tok 的图，recall 线索不能断）；摘要模型输入中图片以 `[图片: mime]` 文本标记呈现；recall 对应 entry 返回文本 + 真图块（~1200 tok/张，按需付费）。L4 合并行的图片信息由摘要描述承载。
```

- [ ] **Step 2: 检查 recall 工具说明段落**，补充「含图 entry 的 recall 返回混合 content（原文文本 + 图片块）」一句话（找到 README 中 recall 工具用法示例处，按上下文措辞自然融入）。

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: README 补充图片 turn 的占位/摘要标记/真图召回说明"
```

---

## Self-Review 记录

- **Spec 覆盖**：§3.1→Task 1；§3.2→Task 2；§3.3→Task 3；§3.4→Task 4（透传风险闸门 Step 6）；§3.5 边界无任务（明确不修）；§4 测试矩阵分布在各任务 Step 1。无缺口。
- **占位符扫描**：无 TBD/TODO；Task 4 Step 1 的 describe 骨架均已给出可执行断言体。
- **类型一致性**：`LedgerQuote.images`（Task 1 定义，Task 2/4 消费）；`RecallImage/RecallResult.images`（Task 4 内定义并消费）；`renderImagesLine`（Task 2 定义导出，测试引用）。签名核对一致。
