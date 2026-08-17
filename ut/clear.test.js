/*
 * Copyright (c) 2026 QuincyLeo (Quincy-Leo)
 * SPDX-License-Identifier: MIT
 */

"use strict";

require("./helpers/bootstrap");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
    ClearAssetsJob,
    FLAG_DUPLICATE_BASENAME,
    FLAG_TEXT_ONLY_MATCH,
    FLAG_UNRESOLVED_LINK,
    REASON_PARSE_FAILED,
    REASON_READ_FAILED,
    REASON_SUSPICIOUS,
    REASON_VAULT_CHANGED,
    SUSPICIOUS_CANDIDATE_RATIO,
    SUSPICIOUS_MIN_TOTAL,
    cleanToken,
    resolveRelative,
} = require("../src/clear");
const { LANGUAGE_OPTIONS, defaultSettings } = require("../src/settings");
const { resolveScope } = require("../src/scope");
const { makeFakePlugin } = require("./helpers/fakePlugin");

// ---------------------------------------------------------------------------
// 测试策略
// ---------------------------------------------------------------------------
// clear.js 是唯一真的删文件的模块，所以这里的重点全部压在 “漏认一个引用就是
// 数据丢失” 这条不对称上：
//   - 引用识别：resolvedLinks / 裸 HTML / CSS url() / frontmatter 裸路径 /
//     canvas 的 file 与 group.background / 相对路径 / 百分号编码 / 尺寸后缀
//   - 失败即中止：读不了、canvas JSON 坏了、Excalidraw 压缩过 → 一律不删
//   - 跳闸：候选占比过高（冷索引的特征）→ 中止而不是清空仓库
//   - 范围：include 递归、exclude 优先、扩展名过滤、md/canvas/base 永不入选
//   - 可疑标记：同名文件 / unresolvedLinks / 只在文本里出现过
//   - 删除前二次校验：弹窗期间变成被引用、或文件已不在 → 保留不删
//   - 四种删除去向各自调用哪个 API，以及老版本 Obsidian 的回退
//   - cancel() 在扫描和删除中途都能立刻止住
// 入口分支在 ut/main.test.js，目录/扩展名解析在 ut/scope.test.js。
// ---------------------------------------------------------------------------

const zh = LANGUAGE_OPTIONS[0];

/**
 * 造一个 job：overrides 直接透给 makeFakePlugin。
 * @param {object} [overrides] contents/paths/resolvedLinks/unresolvedLinks 等
 */
function makeJob(overrides = {}) {
    const fake = makeFakePlugin(overrides);
    const plugin = { app: fake.app, manifest: fake.manifest, uiText: zh };
    const job = new ClearAssetsJob(plugin);
    // 默认认为索引已就绪：绝大多数用例测的不是这道闸。
    job._cacheResolved = true;
    return { job, fake };
}

/** 用默认设置解析出一个覆盖整个仓库的 scope。 */
function scopeFor(fake, patch = {}) {
    const scope = resolveScope({ ...defaultSettings(), ...patch }, fake.app.vault);
    assert.equal(scope.ok, true, `scope 应有效：${JSON.stringify(scope.errors)}`);
    return scope;
}

function paths(candidates) {
    return candidates.map((c) => c.path);
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

test("cleanToken: 剥掉尺寸后缀、子路径、查询串，并解百分号编码", () => {
    assert.equal(cleanToken("a.png"), "a.png");
    assert.equal(cleanToken("  <a b.png>  "), "a b.png");
    assert.equal(cleanToken("a.png|300"), "a.png");
    assert.equal(cleanToken("a.png|300x200"), "a.png");
    assert.equal(cleanToken("note#heading"), "note");
    assert.equal(cleanToken("note#^block-id"), "note");
    assert.equal(cleanToken("a.png?v=2"), "a.png");
    assert.equal(cleanToken("my%20pic.png"), "my pic.png");
    assert.equal(cleanToken("assets\\img\\a.png"), "assets/img/a.png");
    assert.equal(cleanToken("./a.png"), "a.png");
    assert.equal(cleanToken("100%.png"), "100%.png", "不是合法转义时用原文");
    assert.equal(cleanToken("   "), "");
});

test("resolveRelative: 解 ../ 和 ./，但不允许爬出仓库", () => {
    assert.equal(resolveRelative("notes", "a.png"), "notes/a.png");
    assert.equal(resolveRelative("notes/sub", "../a.png"), "notes/a.png");
    assert.equal(resolveRelative("notes", "./a.png"), "notes/a.png");
    assert.equal(resolveRelative("notes", "../../a.png"), "", "越过仓库根一律拒绝");
    assert.equal(resolveRelative("", "a.png"), "a.png");
    assert.equal(resolveRelative("notes", "/abs/a.png"), "abs/a.png", "前导斜杠按仓库根算");
});

// ---------------------------------------------------------------------------
// 索引就绪判定
// ---------------------------------------------------------------------------

test("isCacheReady: 索引没建完时为假 —— 冷索引下扫描等于清空仓库", () => {
    const { job } = makeJob({ paths: ["assets/a.png", "note.md"] });
    job._cacheResolved = false;
    assert.equal(job.isCacheReady(), false);
});

test("isCacheReady: metadataCache 的 resolved 事件到达后为真", () => {
    const { job, fake } = makeJob({ paths: ["assets/a.png"] });
    job._cacheResolved = false;
    fake._fireMetadata("resolved");
    assert.equal(job.isCacheReady(), true);
});

test("isCacheReady: 插件在启动之后才启用（错过 resolved）时看 resolvedLinks 补判", () => {
    const { job } = makeJob({
        paths: ["assets/a.png", "note.md"],
        // 真实实现给每个 TFile 都建一条 resolvedLinks 记录，附件也有。
        resolvedLinks: { "note.md": { "assets/a.png": 1 }, "assets/a.png": {} },
    });
    job._cacheResolved = false;
    assert.equal(job.isCacheReady(), true);
});

test("isCacheReady: 仓库里有 .base 时也能判为就绪 —— 它谁都不索引", () => {
    // .base（以及 1.12 之前的 .canvas）会出现在 getFiles() 里但没有任何东西
    // 索引它。按 “每个文件一条记录” 判的话，这种仓库永远判不出就绪，插件就
    // 一直拒绝执行。
    const { job } = makeJob({
        paths: ["a.md", "b.md", "t.base", "assets/x.png"],
        resolvedLinks: { "a.md": {}, "b.md": {} },
    });
    job._cacheResolved = false;
    assert.equal(job.isCacheReady(), true);
});

test("isCacheReady: resolvedLinks 只有零星几条时仍视为未就绪", () => {
    const { job } = makeJob({
        paths: ["a.md", "b.md", "c.md", "d.md", "e.md", "assets/a.png"],
        resolvedLinks: { "a.md": {} },
    });
    job._cacheResolved = false;
    assert.equal(job.isCacheReady(), false, "冷索引下扫描等于清空仓库，必须挡住");
});

// ---------------------------------------------------------------------------
// 引用识别
// ---------------------------------------------------------------------------

test("resolvedLinks 里的目标算被引用", async () => {
    const { job } = makeJob({
        paths: ["note.md", "assets/used.png", "assets/unused.png"],
        resolvedLinks: { "note.md": { "assets/used.png": 1 } },
    });
    const refs = await job.gatherReferences();
    assert.equal(refs.unsafe, false);
    assert.ok(refs.referenced.has("assets/used.png"));
    assert.ok(!refs.referenced.has("assets/unused.png"));
});

test("裸 HTML 的 <img src> 也算引用 —— metadataCache 完全看不见它", async () => {
    const { job, fake } = makeJob({
        contents: { "note.md": '<img src="assets/a.png" width="400">' },
        paths: ["assets/a.png"],
    });
    const refs = await job.gatherReferences();
    assert.ok(refs.referenced.has("assets/a.png"));
    const { candidates } = job.findCandidates(refs, scopeFor(fake));
    assert.deepEqual(paths(candidates), []);
});

test("CSS 的 url() 与 SVG 的 xlink:href 都算引用", async () => {
    const { job } = makeJob({
        contents: {
            "theme.css": "body { background: url('assets/bg.png'); }",
            "d.svg": '<image xlink:href="assets/icon.png"/>',
        },
        paths: ["assets/bg.png", "assets/icon.png"],
    });
    const refs = await job.gatherReferences();
    assert.ok(refs.referenced.has("assets/bg.png"));
    assert.ok(refs.referenced.has("assets/icon.png"));
});

test("frontmatter 里不带方括号的裸路径也算引用", async () => {
    const { job } = makeJob({
        contents: { "note.md": "---\nbanner: assets/hero.png\n---\n正文" },
        paths: ["assets/hero.png"],
    });
    const refs = await job.gatherReferences();
    assert.ok(refs.referenced.has("assets/hero.png"));
});

test("wiki 链接带尺寸后缀 / 子路径 / 百分号编码都能对上文件", async () => {
    const { job } = makeJob({
        contents: {
            "note.md": "![[assets/a.png|300]]\n[[assets/b.png#anchor]]\n![](assets/my%20pic.png)",
        },
        paths: ["assets/a.png", "assets/b.png", "assets/my pic.png"],
    });
    const refs = await job.gatherReferences();
    assert.ok(refs.referenced.has("assets/a.png"));
    assert.ok(refs.referenced.has("assets/b.png"));
    assert.ok(refs.referenced.has("assets/my pic.png"), "空格要先解码再查表");
});

test("文件名本身带 # / ? / | 时也能对上 —— 剥装饰不能把真文件名剥掉", async () => {
    const { job, fake } = makeJob({
        contents: {
            "note.md": "![](assets/a%231.png)\n![[assets/b?x.png]]\n![](assets/c%7Cd.png)",
        },
        paths: ["assets/a#1.png", "assets/b?x.png", "assets/c|d.png"],
    });
    const refs = await job.gatherReferences();
    assert.ok(refs.referenced.has("assets/a#1.png"), "# 在文件名里");
    assert.ok(refs.referenced.has("assets/b?x.png"), "? 在文件名里");
    assert.ok(refs.referenced.has("assets/c|d.png"), "| 在文件名里");
    const { candidates } = job.findCandidates(refs, scopeFor(fake));
    assert.deepEqual(paths(candidates), []);
});

test("带 #小节 的链接照常算作对目标文件的引用", async () => {
    const { job, fake } = makeJob({
        contents: { "note.md": "![[assets/a.png#1]]\n[t](assets/b.png#^blk)" },
        paths: ["assets/a.png", "assets/b.png"],
    });
    const refs = await job.gatherReferences();
    const { candidates } = job.findCandidates(refs, scopeFor(fake));
    assert.deepEqual(paths(candidates), []);
});

test("Markdown 链接里带空格的路径要用尖括号形式，且能对上文件", async () => {
    const { job } = makeJob({
        contents: { "note.md": "![](<assets/my pic.png>)\n[t](assets/plain.png)" },
        paths: ["assets/my pic.png", "assets/plain.png"],
    });
    const refs = await job.gatherReferences();
    assert.ok(refs.referenced.has("assets/my pic.png"), "尖括号里的空格不能被截断");
    assert.ok(refs.referenced.has("assets/plain.png"));
});

test("相对路径按引用它的笔记所在目录解析", async () => {
    const { job } = makeJob({
        contents: { "notes/sub/n.md": "![](../img/a.png)" },
        paths: ["notes/img/a.png"],
    });
    const refs = await job.gatherReferences();
    assert.ok(refs.referenced.has("notes/img/a.png"));
});

test("兜底扫描覆盖真实世界里各种写法 —— 漏一种就是删掉一个在用的文件", async () => {
    // 逐个单独跑：放在同一篇笔记里的话，任何一条正则命中都会掩盖其他条的漏网。
    const shapes = {
        "assets/ref.png": "![alt][r]\n\n[r]: assets/ref.png",
        "assets/unq.png": "<img src=assets/unq.png width=400>",
        "assets/sq.png": "<img src='assets/sq.png'>",
        "assets/obj.svg": '<object data="assets/obj.svg"></object>',
        "assets/srcset.png": '<source srcset="assets/srcset.png 2x">',
        "assets/is.png": 'background: image-set("assets/is.png" 1x);',
        "assets/list1.png": "---\ngallery:\n  - assets/list1.png\n---",
        "assets/inline.png": "---\ngallery: [assets/inline.png]\n---",
        "assets/tbl.png": "| a | ![[assets/tbl.png]] |",
        "assets/callout.png": "> [!note]\n> ![[assets/callout.png]]",
        "assets/poster.png": '<video poster="assets/poster.png"></video>',
        "assets/bare.png": "见 assets/bare.png 那张图",
        "assets/fn.png": "[^1]: 见 ![[assets/fn.png]]",
        "assets/blk.png": "![[assets/blk.png#^abc123]]",
        "assets/win.png": '<img src="assets\\win.png">',
    };
    for (const [path, text] of Object.entries(shapes)) {
        const { job } = makeJob({ contents: { "note.md": text }, paths: [path] });
        const refs = await job.gatherReferences();
        assert.ok(refs.referenced.has(path), `漏了这种写法：${JSON.stringify(text)}`);
    }
});

test("兜底扫描不会把版本号之类的东西当文件名，以致误标真文件", async () => {
    const { job } = makeJob({
        contents: { "note.md": "版本 1.2.3 发布了\n编辑 package.json\n报告见 report.pdf" },
        paths: ["assets/keep.png"],
    });
    const refs = await job.gatherReferences();
    assert.equal(refs.referenced.size, 0, "都不是仓库里的文件");
    assert.ok(!refs.textOnly.has("1.2.3"), "纯数字不算文件名");
    assert.ok(refs.textOnly.has("package.json"), "带真扩展名的仍要记下来");
});

// ---------------------------------------------------------------------------
// 下面这批来自一次对抗式评审：每一条都是 “会把在用文件删掉” 的具体路径
// ---------------------------------------------------------------------------

test("Obsidian 默认粘贴名（带空格）在各种写法下都算引用", async () => {
    // `Pasted image 20260101120000.png` 是 Obsidian 自己的默认命名，也就是仓库里
    // 最常见的附件名。兜底正则若按空白分隔，它在这些写法下一个都认不出来。
    const p = "assets/Pasted image 20260811100000.png";
    for (const [label, text] of Object.entries({
        "yaml 列表": `---\ngallery:\n  - ${p}\n---`,
        "未知键的裸路径": `---\nmycover: ${p}\n---`,
        srcset: `<img srcset="${p} 2x">`,
        "散文里提到": `见 ${p} 那张图`,
    })) {
        const { job, fake } = makeJob({ contents: { "note.md": text }, paths: [p] });
        const refs = await job.gatherReferences();
        assert.ok(refs.referenced.has(p), `${label} 没认出来`);
        const { candidates } = job.findCandidates(refs, scopeFor(fake));
        assert.deepEqual(paths(candidates), [], label);
    }
});

test("认不出来的带空格文件名至少要留下疑点，不能默认勾选", async () => {
    // 兜底解析终究有极限。极限之外的正确行为是 “标疑点、默认不勾选”，
    // 而不是 “当成没人用、默认勾选”。
    const { job, fake } = makeJob({
        contents: { "note.md": '<img src="旧目录/Pasted image 1.png">' },
        paths: ["assets/Pasted image 1.png"],
    });
    const refs = await job.gatherReferences();
    const { candidates } = job.findCandidates(refs, scopeFor(fake));
    assert.equal(candidates.length, 1);
    assert.ok(candidates[0].flags.length > 0, "拿不准的必须默认不勾选");
});

test("内联 base64 不会让扫描卡死 —— 兜底正则必须是线性的", async () => {
    // 未压缩的 Excalidraw 画板就把每张粘贴的图存成 data URI。旧写法在 80KB
    // 上要跑 4.9 秒、160KB 要 20 秒，而且 _collectFromText 是同步的，
    // yieldToUi 和取消都插不进去。
    const payload = "A".repeat(120 * 1024);
    const { job } = makeJob({
        contents: { "d.svg": `<svg><image href="data:image/png;base64,${payload}"/></svg>` },
        paths: ["assets/a.png"],
    });
    const started = Date.now();
    await job.gatherReferences();
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1000, `120KB 的 data URI 花了 ${elapsed}ms，应当是毫秒级`);
});

test("不在扫描列表里的文本扩展名也要读 —— 它可能是唯一的引用来源", async () => {
    for (const [label, file] of Object.entries({
        excalidraw: "d.excalidraw",
        "用户脚本": "scripts/icons.js",
        yaml: "conf.yml",
        csv: "data.csv",
        "没听过的扩展名": "notes.myformat",
    })) {
        const { job, fake } = makeJob({
            contents: { [file]: '{"path":"assets/a.png"}' },
            paths: ["assets/a.png"],
        });
        const refs = await job.gatherReferences();
        assert.ok(refs.referenced.has("assets/a.png"), `${label} 里的引用被漏掉了`);
        assert.deepEqual(paths(job.findCandidates(refs, scopeFor(fake)).candidates), [], label);
    }
});

test("已知的二进制格式不读 —— 读了也没有文本引用，纯浪费", async () => {
    const { job } = makeJob({ paths: ["assets/a.png", "big.mp4", "doc.pdf"] });
    const read = [];
    const realRead = job.app.vault.cachedRead.bind(job.app.vault);
    job.app.vault.cachedRead = async (file) => { read.push(file.path); return realRead(file); };
    await job.gatherReferences();
    assert.deepEqual(read, [], "png / mp4 / pdf 都不该被读");
});

test("伪装成文本的二进制文件（含 NUL）跳过而不是中止", async () => {
    // 扩展名不认识、内容其实是二进制 —— 里面没有文本引用，跳过不丢信息。
    const { job } = makeJob({
        contents: { "weird.dat": `PK  binary junk` },
        paths: ["assets/a.png"],
    });
    const refs = await job.gatherReferences();
    assert.equal(refs.unsafe, false, "不认识的二进制不该让整次运行中止");
});

test("Markdown 链接缺右括号时不会吞掉下一条引用", async () => {
    // 文件名里带逗号是关键：兜底正则的字符类把逗号排除在外，所以只有尖括号
    // 这条 Markdown 正则能整条认出它。这条正则的贪婪尾巴 `[^)]*` 会跨行，
    // 缺一个右括号就把下一行整条吞掉，而且没有第二条正则来补救。
    const { job, fake } = makeJob({
        contents: { "n.txt": "![](<assets/one,pic.png>\n![](<assets/two,pic.png>)" },
        paths: ["assets/one,pic.png", "assets/two,pic.png"],
    });
    const refs = await job.gatherReferences();
    assert.ok(refs.referenced.has("assets/two,pic.png"), "被前一条的贪婪尾巴吞了");
    assert.deepEqual(paths(job.findCandidates(refs, scopeFor(fake)).candidates), []);
});

test("一个 token 能解析出两个文件时两个都记 —— 不能只认第一个", async () => {
    // `assets/photo #2.png` 剥掉 “#子路径” 后是 `assets/photo`，而
    // getFirstLinkpathDest 会给无扩展名的 linkpath 补 .md，于是命中另一个文件。
    // 只认第一个的话，真正被引用的那张图就成了默认勾选的候选。
    const entriesRef = {};
    const { job, fake } = makeJob({
        contents: { "note.md": '<img src="assets/photo #2.png">' },
        paths: ["assets/photo.md", "assets/photo #2.png"],
        linkResolver: (linkpath) => {
            const e = entriesRef.map;
            if (e.has(linkpath)) return e.get(linkpath);
            if (!/\.[a-z0-9]+$/i.test(linkpath) && e.has(`${linkpath}.md`)) {
                return e.get(`${linkpath}.md`);
            }
            return null;
        },
    });
    entriesRef.map = fake._entries;
    const refs = await job.gatherReferences();
    assert.ok(refs.referenced.has("assets/photo #2.png"), "真文件名那一解释被丢了");
    assert.deepEqual(paths(job.findCandidates(refs, scopeFor(fake)).candidates), []);
});

test("文件名看着像 URI scheme（note:2.png）不能直接当外链丢掉", async () => {
    const { job, fake } = makeJob({
        contents: { "note.md": '<img src="note:2.png">' },
        paths: ["note:2.png"],
    });
    const refs = await job.gatherReferences();
    assert.ok(refs.referenced.has("note:2.png"));
    assert.deepEqual(paths(job.findCandidates(refs, scopeFor(fake)).candidates), []);
});

test("文件名真含 %20 时也要留下疑点", async () => {
    // 浏览器下载常留下这种名字。解码后的路径不存在，但原样拼写正是文件名。
    const { job, fake } = makeJob({
        contents: { "note.md": '<img src="assets/my%20photo.jpg">' },
        paths: ["assets/my%20photo.jpg"],
    });
    const refs = await job.gatherReferences();
    const { candidates } = job.findCandidates(refs, scopeFor(fake));
    assert.equal(candidates.length, 1);
    assert.deepEqual(candidates[0].flags, [FLAG_TEXT_ONLY_MATCH]);
});

test("NFD 文件名的候选能被真的删掉 —— 候选身份必须是仓库自己的拼写", async () => {
    // getAbstractFileByPath 是组合敏感的精确查表。候选路径若被规范成 NFC，
    // 删除时就查不到，用户每次都被告知 “文件不见了”，而且永远修不好。
    const nfd = "assets/café.png";
    const { job, fake } = makeJob({ contents: { "note.md": "无关" }, paths: [nfd] });
    const refs = await job.gatherReferences();
    const { candidates } = job.findCandidates(refs, scopeFor(fake));
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].path, nfd, "候选身份要保持盘上的原始拼写");
    const deletion = await job.deleteSelected([candidates[0].path], { destination: ".trash" });
    assert.deepEqual(deletion.deleted, [nfd]);
    assert.deepEqual(deletion.kept, []);
});

test("deleteSelected: 二次校验期间仓库发生变化 → 一个都不删", async () => {
    // gatherReferences 在开头快照一次文件列表，所以校验途中新到的笔记根本
    // 读不到。run() 已经用指纹挡住了，不可逆的这条路更需要挡。
    const { job, fake } = makeJob({
        contents: { "note.md": "无关正文" },
        paths: ["assets/hero.png"],
    });
    const { TFile } = require("obsidian");
    const realRead = fake.app.vault.cachedRead.bind(fake.app.vault);
    let injected = false;
    fake.app.vault.cachedRead = async (file) => {
        if (!injected) {
            injected = true;
            const added = new TFile();
            added.path = "zzz.md";
            added.name = "zzz.md";
            added.basename = "zzz";
            added.extension = "md";
            added.stat = { size: 30, mtime: Date.now(), ctime: 1 };
            added.__contents = "![[assets/hero.png]]";
            fake._entries.set("zzz.md", added);
        }
        return realRead(file);
    };
    const deletion = await job.deleteSelected(["assets/hero.png"], { destination: "permanent" });
    assert.deepEqual(deletion.deleted, []);
    assert.deepEqual(deletion.kept, [{ path: "assets/hero.png", reason: "vault-changed" }]);
    assert.deepEqual(fake._deleted, [], "永久删除绝不能在这种情况下发生");
});

test("外部链接不去查表，也不产生可疑标记", async () => {
    const { job } = makeJob({
        contents: {
            "note.md": '![](https://x.com/a.png)\n<img src="data:image/png;base64,AAAA">',
        },
        paths: ["assets/a.png"],
    });
    const refs = await job.gatherReferences();
    assert.equal(refs.referenced.size, 0);
    assert.equal(refs.textOnly.size, 0);
});

test("canvas 的 file 节点与 group 背景图都算引用", async () => {
    const canvas = JSON.stringify({
        nodes: [
            { type: "file", file: "assets/in-canvas.png" },
            { type: "group", background: "assets/group-bg.png" },
            { type: "text", text: "![[assets/in-text.png]]" },
        ],
    });
    const { job } = makeJob({
        contents: { "board.canvas": canvas },
        paths: ["assets/in-canvas.png", "assets/group-bg.png", "assets/in-text.png"],
    });
    const refs = await job.gatherReferences();
    assert.ok(refs.referenced.has("assets/in-canvas.png"));
    assert.ok(refs.referenced.has("assets/group-bg.png"), "group.background 最容易被漏掉");
    assert.ok(refs.referenced.has("assets/in-text.png"));
});

test("_collectFromCanvas 本身认 file 与 background 两个键", async () => {
    // 上一个用例走的是整条 gatherReferences，而通用的 "key": "value" 正则也会
    // 顺手命中 canvas JSON —— 那就掩盖了结构化遍历自己是否还工作。这里直接调
    // 遍历函数，把它单独钉住。
    const { job } = makeJob({ paths: ["assets/f.png", "assets/bg.png"] });
    const result = { referenced: new Set(), textOnly: new Set(), unresolved: new Set() };
    job._collectFromCanvas({
        nodes: [
            { type: "file", file: "assets/f.png" },
            { type: "group", background: "assets/bg.png" },
            null,
            { type: "text", text: "无关" },
        ],
    }, { path: "board.canvas" }, result);
    assert.deepEqual([...result.referenced].sort(), ["assets/bg.png", "assets/f.png"]);
});

test(".base 文件里的图片属性也算引用", async () => {
    const { job } = makeJob({
        contents: { "table.base": 'views:\n  - type: cards\n    image: "assets/card.png"\n' },
        paths: ["assets/card.png"],
    });
    const refs = await job.gatherReferences();
    assert.ok(refs.referenced.has("assets/card.png"));
});

// ---------------------------------------------------------------------------
// 失败即中止
// ---------------------------------------------------------------------------

test("读不了某个文本文件 → unsafe，并报出它的路径", async () => {
    const { job, fake } = makeJob({ paths: ["note.md", "assets/a.png"] });
    fake._entries.get("note.md").__readError = "EIO";
    const refs = await job.gatherReferences();
    assert.equal(refs.unsafe, true);
    assert.deepEqual(refs.reasons[0], { kind: REASON_READ_FAILED, path: "note.md" });
});

test("canvas JSON 坏了 → unsafe（只被它引用的图片绝不能因此被删）", async () => {
    const { job } = makeJob({
        contents: { "board.canvas": '{"nodes":[{"type":"file","file":"assets/a.pn' },
        paths: ["assets/a.png"],
    });
    const refs = await job.gatherReferences();
    assert.equal(refs.unsafe, true);
    assert.deepEqual(refs.reasons[0], { kind: REASON_PARSE_FAILED, path: "board.canvas" });
});

test("Excalidraw 压缩过的画板 → unsafe：谁都读不出它用了哪些图", async () => {
    const { job } = makeJob({
        contents: {
            "draw.excalidraw.md": "# Excalidraw Data\n\n```compressed-json\nN4Ig…\n```\n",
        },
        paths: ["assets/a.png"],
    });
    const refs = await job.gatherReferences();
    assert.equal(refs.unsafe, true);
    assert.equal(refs.reasons[0].kind, REASON_PARSE_FAILED);
});

test("run: unsafe → aborted 且候选清单为空", async () => {
    const { job, fake } = makeJob({ paths: ["note.md", "assets/a.png"] });
    fake._entries.get("note.md").__readError = "EIO";
    const result = await job.run(scopeFor(fake));
    assert.equal(result.aborted, true);
    assert.deepEqual(result.candidates, []);
    assert.equal(result.abortReason.kind, REASON_READ_FAILED);
});

test("run: 扫描期间仓库发生变化 → 按 vault-changed 中止", async () => {
    const { job, fake } = makeJob({
        contents: { "note.md": "![[assets/a.png]]" },
        paths: ["assets/a.png", "assets/b.png"],
    });
    const realGather = job.gatherReferences.bind(job);
    job.gatherReferences = async () => {
        const refs = await realGather();
        // 模拟扫描过程中有人改了笔记。
        fake._entries.get("note.md").stat.mtime += 1000;
        return refs;
    };
    const result = await job.run(scopeFor(fake));
    assert.equal(result.aborted, true);
    assert.equal(result.abortReason.kind, REASON_VAULT_CHANGED);
    assert.deepEqual(result.candidates, []);
});

test("run: 扫描期间新增和删除各一个文件（数量不变）也算仓库变了", async () => {
    const { job, fake } = makeJob({
        contents: { "note.md": "![[assets/a.png]]" },
        paths: ["assets/a.png", "assets/b.png"],
    });
    const realGather = job.gatherReferences.bind(job);
    job.gatherReferences = async () => {
        const refs = await realGather();
        // 一加一减：只看文件数或 mtime 之和的指纹会认不出来。
        const gone = fake._entries.get("assets/b.png");
        fake._entries.delete("assets/b.png");
        const added = Object.create(Object.getPrototypeOf(gone));
        Object.assign(added, gone, { path: "assets/c.png", name: "c.png" });
        fake._entries.set("assets/c.png", added);
        return refs;
    };
    const result = await job.run(scopeFor(fake));
    assert.equal(result.aborted, true);
    assert.equal(result.abortReason.kind, REASON_VAULT_CHANGED);
});

test("run: 候选占比过高 → 按 suspicious 中止，并把两个数字带在原因里", async () => {
    const files = [];
    for (let i = 0; i < SUSPICIOUS_MIN_TOTAL + 2; i++) files.push(`assets/a${i}.png`);
    const { job, fake } = makeJob({ paths: files.concat(["note.md"]) });
    const result = await job.run(scopeFor(fake));
    assert.equal(result.aborted, true);
    assert.equal(result.abortReason.kind, REASON_SUSPICIOUS);
    assert.equal(result.abortReason.total, files.length);
    assert.equal(result.abortReason.candidates, files.length);
    assert.deepEqual(result.candidates, [], "中止时不能把半成品清单当答案交出去");
});

test("run: 附件太少时不触发跳闸 —— 三张没人用的截图是正常的", async () => {
    const { job, fake } = makeJob({ paths: ["assets/a.png", "assets/b.png", "note.md"] });
    assert.ok(SUSPICIOUS_MIN_TOTAL > 2);
    const result = await job.run(scopeFor(fake));
    assert.equal(result.aborted, false);
    assert.deepEqual(paths(result.candidates), ["assets/a.png", "assets/b.png"]);
});

// ---------------------------------------------------------------------------
// 范围与可疑标记
// ---------------------------------------------------------------------------

test("findCandidates: 只看扩展名在列表里的文件，md/canvas/base 永不入选", async () => {
    const { job, fake } = makeJob({
        paths: ["note.md", "board.canvas", "t.base", "assets/a.png", "assets/a.mp4"],
    });
    const refs = await job.gatherReferences();
    const { candidates } = job.findCandidates(refs, scopeFor(fake));
    assert.deepEqual(paths(candidates), ["assets/a.png"], "mp4 不在默认扩展名里");
});

test("findCandidates: include 递归包含子目录，exclude 优先级更高", async () => {
    const { job, fake } = makeJob({
        paths: [
            "assets/a.png",
            "assets/sub/b.png",
            "assets/keep/c.png",
            "other/d.png",
        ],
    });
    const refs = await job.gatherReferences();
    const scope = scopeFor(fake, {
        includeFolders: "assets",
        excludeFolders: "assets/keep",
    });
    const { candidates, total } = job.findCandidates(refs, scope);
    assert.deepEqual(paths(candidates), ["assets/a.png", "assets/sub/b.png"]);
    assert.equal(total, 2, "total 也只算范围内的");
});

test("findCandidates: 同名文件互相干扰 → 标 duplicate-basename 并默认不勾选", async () => {
    const { job, fake } = makeJob({
        contents: { "note.md": "![[logo.png]]" },
        paths: ["assets/logo.png", "archive/logo.png"],
        // getFirstLinkpathDest 只会返回一个，另一个就 “看着没人用”。
        linkResolver: (linkpath) => (linkpath === "logo.png"
            ? { path: "assets/logo.png", extension: "png" }
            : null),
    });
    const refs = await job.gatherReferences();
    const { candidates } = job.findCandidates(refs, scopeFor(fake));
    assert.deepEqual(paths(candidates), ["archive/logo.png"]);
    assert.deepEqual(candidates[0].flags, [FLAG_DUPLICATE_BASENAME]);
});

test("findCandidates: 名字出现在 unresolvedLinks 里 → 标 unresolved-link", async () => {
    const { job, fake } = makeJob({
        paths: ["assets/a.png", "note.md"],
        unresolvedLinks: { "note.md": { "a.png": 1 } },
    });
    const refs = await job.gatherReferences();
    const { candidates } = job.findCandidates(refs, scopeFor(fake));
    assert.deepEqual(candidates[0].flags, [FLAG_UNRESOLVED_LINK]);
});

test("findCandidates: 只在纯文本里出现过（链接已断）→ 标 text-only-match", async () => {
    const { job, fake } = makeJob({
        // 目录改过名，src 指向的旧路径已不存在，但用户显然想引用这个文件名。
        contents: { "note.md": '<img src="old-folder/a.png">' },
        paths: ["assets/a.png"],
    });
    const refs = await job.gatherReferences();
    assert.ok(refs.textOnly.has("a.png"));
    const { candidates } = job.findCandidates(refs, scopeFor(fake));
    assert.deepEqual(candidates[0].flags, [FLAG_TEXT_ONLY_MATCH]);
});

test("findCandidates: 候选带扩展名与体积，且按路径排序", async () => {
    const { job, fake } = makeJob({ paths: ["b/z.png", "a/y.png"] });
    const refs = await job.gatherReferences();
    const { candidates } = job.findCandidates(refs, scopeFor(fake));
    assert.deepEqual(paths(candidates), ["a/y.png", "b/z.png"]);
    assert.equal(candidates[0].extension, "png");
    assert.ok(candidates[0].size > 0, "体积取自 stat.size");
});

// ---------------------------------------------------------------------------
// 删除
// ---------------------------------------------------------------------------

test("deleteSelected: 四种去向各自调用对应 API", async () => {
    for (const [destination, expected] of [
        [".trash", { path: "assets/a.png", system: false }],
        ["system-trash", { path: "assets/a.png", system: true }],
        ["obsidian-setting", { path: "assets/a.png", system: "setting" }],
    ]) {
        const { job, fake } = makeJob({ paths: ["assets/a.png"] });
        const result = await job.deleteSelected(["assets/a.png"], { destination });
        assert.deepEqual(result.deleted, ["assets/a.png"], destination);
        assert.deepEqual(fake._trashed[0], expected, destination);
        assert.equal(result.destinationUsed, destination);
    }
    const { job, fake } = makeJob({ paths: ["assets/a.png"] });
    const result = await job.deleteSelected(["assets/a.png"], { destination: "permanent" });
    assert.deepEqual(fake._deleted, ["assets/a.png"]);
    assert.deepEqual(fake._trashed, [], "永久删除不能走回收站");
    assert.equal(result.destinationUsed, "permanent");
});

test("deleteSelected: 老版本没有 trashFile → 回退到 .trash 并如实上报", async () => {
    const { job, fake } = makeJob({ paths: ["assets/a.png"] });
    delete fake.app.fileManager.trashFile;
    const result = await job.deleteSelected(["assets/a.png"], {
        destination: "obsidian-setting",
    });
    assert.deepEqual(fake._trashed[0], { path: "assets/a.png", system: false });
    assert.equal(result.destinationUsed, ".trash", "去向变了就必须说");
});

test("deleteSelected: 弹窗期间文件变成被引用 → 保留不删", async () => {
    const { job, fake } = makeJob({
        paths: ["assets/a.png", "assets/b.png"],
        // 模拟同步在弹窗打开期间送来了一篇引用 a.png 的笔记。
        resolvedLinks: { "synced.md": { "assets/a.png": 1 } },
    });
    const result = await job.deleteSelected(["assets/a.png", "assets/b.png"], {
        destination: ".trash",
    });
    assert.deepEqual(result.deleted, ["assets/b.png"]);
    assert.deepEqual(result.kept, [{ path: "assets/a.png", reason: "now-referenced" }]);
    assert.deepEqual(fake._trashed.map((t) => t.path), ["assets/b.png"]);
});

test("deleteSelected: 文件已被别处删掉或改名 → 记为 missing，不按路径乱删", async () => {
    const { job, fake } = makeJob({ paths: ["assets/a.png"] });
    fake._entries.delete("assets/a.png");
    const result = await job.deleteSelected(["assets/a.png"], { destination: ".trash" });
    assert.deepEqual(result.deleted, []);
    assert.deepEqual(result.kept, [{ path: "assets/a.png", reason: "missing" }]);
});

test("deleteSelected: 二次校验本身不可信 → 一个都不删", async () => {
    const { job, fake } = makeJob({ paths: ["note.md", "assets/a.png"] });
    fake._entries.get("note.md").__readError = "EIO";
    const result = await job.deleteSelected(["assets/a.png"], { destination: ".trash" });
    assert.deepEqual(result.deleted, []);
    assert.deepEqual(result.kept, [{ path: "assets/a.png", reason: "verify-failed" }]);
});

test("deleteSelected: 单个文件删除失败只记账，不影响其余文件", async () => {
    const { job, fake } = makeJob({ paths: ["assets/a.png", "assets/b.png"] });
    fake.app.vault.trash = async (file) => {
        if (file.path === "assets/a.png") throw new Error("EPERM");
        fake._trashed.push({ path: file.path, system: false });
    };
    const result = await job.deleteSelected(["assets/a.png", "assets/b.png"], {
        destination: ".trash",
    });
    assert.deepEqual(result.deleted, ["assets/b.png"]);
    assert.deepEqual(result.failed, [{ path: "assets/a.png", error: "EPERM" }]);
});

test("deleteSelected: 上报进度", async () => {
    const { job } = makeJob({ paths: ["assets/a.png", "assets/b.png"] });
    const seen = [];
    await job.deleteSelected(["assets/a.png", "assets/b.png"], {
        destination: ".trash",
        onProgress: (p) => seen.push(`${p.current}/${p.total} ${p.path}`),
    });
    assert.deepEqual(seen, ["1/2 assets/a.png", "2/2 assets/b.png"]);
});

test("deleteSelected: 空清单直接返回，不去读盘", async () => {
    const { job, fake } = makeJob({ paths: ["assets/a.png"] });
    let reads = 0;
    fake.app.vault.cachedRead = async () => { reads += 1; return ""; };
    const result = await job.deleteSelected([], { destination: ".trash" });
    assert.deepEqual(result.deleted, []);
    assert.equal(reads, 0);
});

// ---------------------------------------------------------------------------
// 取消
// ---------------------------------------------------------------------------

test("cancel: 同步生效，且不会永久废掉 job", () => {
    const { job } = makeJob();
    const first = job._newRunToken();
    assert.equal(first.isCancelled(), false);
    job.cancel();
    assert.equal(first.isCancelled(), true, "旧代号立刻失效");
    const second = job._newRunToken();
    assert.equal(second.isCancelled(), false, "新代号必须重新可用");
});

test("cancel: 扫描中途取消 → cancelled 为真，不产出候选", async () => {
    const { job, fake } = makeJob({
        contents: { "a.md": "x", "b.md": "y" },
        paths: ["assets/a.png"],
    });
    const realRead = fake.app.vault.cachedRead.bind(fake.app.vault);
    fake.app.vault.cachedRead = async (file) => {
        job.cancel();
        return realRead(file);
    };
    const result = await job.run(scopeFor(fake));
    assert.equal(result.cancelled, true);
    assert.deepEqual(result.candidates, []);
});

test("cancel: 删除中途取消 → 后续文件不再删", async () => {
    const { job, fake } = makeJob({ paths: ["assets/a.png", "assets/b.png"] });
    fake.app.vault.trash = async (file) => {
        fake._trashed.push({ path: file.path, system: false });
        job.cancel();
    };
    const result = await job.deleteSelected(["assets/a.png", "assets/b.png"], {
        destination: ".trash",
    });
    assert.equal(result.cancelled, true);
    assert.deepEqual(fake._trashed.map((t) => t.path), ["assets/a.png"]);
});

// ---------------------------------------------------------------------------
// 常量契约
// ---------------------------------------------------------------------------

test("REASON_* / FLAG_* 字面量固定 —— main.js 与弹窗都按它们分支", () => {
    assert.equal(REASON_READ_FAILED, "read-failed");
    assert.equal(REASON_PARSE_FAILED, "parse-failed");
    assert.equal(REASON_VAULT_CHANGED, "vault-changed");
    assert.equal(REASON_SUSPICIOUS, "suspicious");
    assert.equal(FLAG_DUPLICATE_BASENAME, "duplicate-basename");
    assert.equal(FLAG_TEXT_ONLY_MATCH, "text-only-match");
    assert.equal(FLAG_UNRESOLVED_LINK, "unresolved-link");
});

test("可疑比例阈值在 (0, 1] 内，否则跳闸逻辑没有意义", () => {
    assert.ok(SUSPICIOUS_CANDIDATE_RATIO > 0 && SUSPICIOUS_CANDIDATE_RATIO <= 1);
    assert.ok(SUSPICIOUS_MIN_TOTAL > 0);
});
