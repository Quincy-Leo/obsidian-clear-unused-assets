/*
 * Copyright (c) 2026 QuincyLeo (Quincy-Leo)
 * SPDX-License-Identifier: MIT
 */

"use strict";

require("./helpers/bootstrap");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
    LANGUAGE_OPTIONS,
    defaultSettings,
    localizedError,
} = require("../src/settings");
const {
    VAULT_ROOT,
    canonicalizeFolderPath,
    isUnderFolder,
    parseExtensions,
    parseFolderList,
    resolveScope,
} = require("../src/scope");
const { makeFakePlugin } = require("./helpers/fakePlugin");

// ---------------------------------------------------------------------------
// 测试策略
// ---------------------------------------------------------------------------
// resolveScope 是 “这次运行允许动哪些文件” 的唯一判据，设置页和命令入口都调它，
// 所以这里把它的每条拒绝理由和每个易错边界都钉住：
//   - 绝对路径必须在规范化之前判定（normalizePath 会把 "/a" 变成 "a"）
//   - 目录递归匹配必须锚在 "/" 上，"assets" 不能吞掉 "assets-old"
//   - 排除目录与清理目录同等严格：排除写错必须中止，而不是静默失去保护
//   - md / canvas / base 即便写进扩展名也必须被忽略
//   - 空清理目录 = 整个仓库；空排除 = 不排除
// ---------------------------------------------------------------------------

/** 造一个含固定目录树的 vault。 */
function vaultWith(paths) {
    return makeFakePlugin({ paths }).app.vault;
}

/** 把设置字段并进默认配置。 */
function settingsWith(patch) {
    return { ...defaultSettings(), ...patch };
}

test("canonicalizeFolderPath: 反斜杠、重复斜杠、首尾斜杠、./ 前缀都归一", () => {
    assert.equal(canonicalizeFolderPath("assets"), "assets");
    assert.equal(canonicalizeFolderPath("  assets/img  "), "assets/img");
    assert.equal(canonicalizeFolderPath("assets\\img"), "assets/img");
    assert.equal(canonicalizeFolderPath("assets//img//"), "assets/img");
    assert.equal(canonicalizeFolderPath("/assets/"), "assets");
    assert.equal(canonicalizeFolderPath("./assets"), "assets");
    assert.equal(canonicalizeFolderPath(""), "");
});

test("canonicalizeFolderPath: macOS 的 NFD 文件名与设置里的 NFC 写法能对上", () => {
    const nfd = "Str\u006F\u0308me";
    const nfc = "Str\u00F6me";
    assert.notEqual(nfd, nfc, "两种写法本身不相等");
    assert.equal(canonicalizeFolderPath(nfd), canonicalizeFolderPath(nfc));
});

test("parseFolderList: 空行丢弃、重复计一次，但每一行都要留给校验看", () => {
    const { paths, lines } = parseFolderList("assets\n\n  \nassets\n/assets/\n/");
    assert.deepEqual(paths, ["assets", VAULT_ROOT], "去重后的规范路径");
    assert.deepEqual(
        lines.map((l) => l.raw),
        ["assets", "assets", "/assets/", "/"],
        "原始行必须全部保留，否则重复行里的绝对路径会漏过校验",
    );
});

test("isUnderFolder: 前缀匹配锚在 / 上，assets 不匹配 assets-old", () => {
    assert.equal(isUnderFolder("assets/a.png", "assets"), true);
    assert.equal(isUnderFolder("assets/sub/a.png", "assets"), true, "递归包含子目录");
    assert.equal(isUnderFolder("assets", "assets"), true, "目录自身算在内");
    assert.equal(isUnderFolder("assets-old/a.png", "assets"), false);
    assert.equal(isUnderFolder("assetsBackup/a.png", "assets"), false);
    assert.equal(isUnderFolder("photos/assets/a.png", "assets"), false, "不能匹配中间路径");
    assert.equal(isUnderFolder("anything/at/all.png", VAULT_ROOT), true, "根目录匹配一切");
});

test("isUnderFolder: 用户输入里的正则元字符不被当成正则", () => {
    assert.equal(isUnderFolder("myXfolder/a.png", "my.folder"), false);
    assert.equal(isUnderFolder("my.folder/a.png", "my.folder"), true);
});

test("parseExtensions: 去点、小写、去重、丢空，md/canvas/base 被拒", () => {
    const { extensions, rejected } = parseExtensions(" .PNG , jpg,jpg, ,*.WebP ,md,canvas,base");
    assert.deepEqual(extensions, ["png", "jpg", "webp"]);
    assert.deepEqual(rejected, ["md", "canvas", "base"]);
});

test("parseExtensions: 不可能成为扩展名的写法被拒，而不是留下来永远匹配不上", () => {
    // 用空格或分号分隔是最常见的手滑，留下来的话配置看着有效、跑起来永远
    // “没有未被引用的附件”。
    assert.deepEqual(parseExtensions("png jpg gif").extensions, []);
    assert.deepEqual(parseExtensions("png jpg gif").rejected, ["png jpg gif"]);
    assert.deepEqual(parseExtensions("PNG;JPG").extensions, []);
    assert.deepEqual(parseExtensions("png.").extensions, ["png"], "尾点应被容忍");
    assert.deepEqual(parseExtensions("p*g").extensions, []);
});

test("resolveScope: 扩展名写成空格分隔 → 校验直接报空，不放它过去", () => {
    const scope = resolveScope(
        settingsWith({ extensions: "png jpg" }),
        vaultWith(["assets/a.png"]),
    );
    assert.equal(scope.ok, false);
    assert.ok(scope.errors.some((e) => e.key === "extensionsEmpty"));
});

test("parseExtensions: 全是尾逗号 / 空白时结果为空，不会退化成 “匹配一切”", () => {
    assert.deepEqual(parseExtensions(",, , ,").extensions, []);
    assert.deepEqual(parseExtensions("").extensions, []);
});

test("resolveScope: 默认配置（清理目录留空）→ 范围是整个仓库", () => {
    const scope = resolveScope(defaultSettings(), vaultWith(["assets/a.png"]));
    assert.equal(scope.ok, true);
    assert.deepEqual(scope.includeFolders, [VAULT_ROOT]);
    assert.deepEqual(scope.excludeFolders, []);
    assert.deepEqual(scope.extensions, ["png", "jpg", "jpeg", "gif", "bmp", "svg", "webp", "avif"]);
});

test("resolveScope: 清理目录写绝对路径 → 报 includeFolderAbsolute", () => {
    const vault = vaultWith(["assets/a.png"]);
    for (const bad of ["/assets", "\\assets", "C:\\pics", "~/pics", "\\\\server\\share"]) {
        const scope = resolveScope(settingsWith({ includeFolders: bad }), vault);
        assert.equal(scope.ok, false, bad);
        assert.equal(scope.errors[0].key, "includeFolderAbsolute", bad);
        assert.equal(scope.errors[0].params.path, bad, "报错要回显用户原始输入");
    }
});

test("resolveScope: 清理目录含 .. → 按绝对路径拒绝，不解析不跟随", () => {
    const scope = resolveScope(
        settingsWith({ includeFolders: "../outside" }),
        vaultWith(["assets/a.png"]),
    );
    assert.equal(scope.ok, false);
    assert.equal(scope.errors[0].key, "includeFolderAbsolute");
});

test("resolveScope: 绝对路径写在重复行上也必须被拒 —— 不能因为去重而漏过", () => {
    const vault = vaultWith(["assets/a.png"]);
    // 两种顺序都要报错：先合法后绝对、先绝对后合法。
    for (const raw of ["assets\n/assets", "/assets\nassets", "assets\n\\assets"]) {
        const scope = resolveScope(settingsWith({ includeFolders: raw }), vault);
        assert.equal(scope.ok, false, raw);
        assert.ok(
            scope.errors.some((e) => e.key === "includeFolderAbsolute"),
            `${raw} 应报绝对路径`,
        );
    }
    const scope = resolveScope(settingsWith({ excludeFolders: "assets\n/assets" }), vault);
    assert.ok(scope.errors.some((e) => e.key === "excludeFolderAbsolute"));
});

test("resolveScope: 目录名字面是 __proto__ 也照常报错，不会渲染成 [object Object]", () => {
    const scope = resolveScope(
        settingsWith({ includeFolders: "__proto__\n__proto__" }),
        vaultWith(["assets/a.png"]),
    );
    assert.equal(scope.ok, false);
    assert.deepEqual(
        scope.errors.filter((e) => e.key === "includeFolderMissing").map((e) => e.params.path),
        ["__proto__", "__proto__"],
    );
});

test("resolveScope: 清理目录全都非法时范围是空，而不是整个仓库", () => {
    const scope = resolveScope(
        settingsWith({ includeFolders: "typo" }),
        vaultWith(["assets/a.png"]),
    );
    assert.equal(scope.ok, false);
    assert.deepEqual(scope.includeFolders, [], "失败时的默认必须是 “什么都不动”");
});

test("resolveScope: 清理目录不存在 → 报 includeFolderMissing", () => {
    const scope = resolveScope(
        settingsWith({ includeFolders: "assets/typo" }),
        vaultWith(["assets/a.png"]),
    );
    assert.equal(scope.ok, false);
    assert.equal(scope.errors[0].key, "includeFolderMissing");
    assert.equal(scope.errors[0].params.path, "assets/typo");
});

test("resolveScope: 清理目录指向一个文件 → 报 includeFolderNotFolder", () => {
    const scope = resolveScope(
        settingsWith({ includeFolders: "assets/a.png" }),
        vaultWith(["assets/a.png"]),
    );
    assert.equal(scope.ok, false);
    assert.equal(scope.errors[0].key, "includeFolderNotFolder");
});

test("resolveScope: 排除目录写错同样中止 —— 静默失去保护比不干活危险得多", () => {
    const vault = vaultWith(["assets/keep_forever/a.png"]);
    const scope = resolveScope(
        settingsWith({ excludeFolders: "assets/keep-forever" }),
        vault,
    );
    assert.equal(scope.ok, false);
    assert.equal(scope.errors[0].key, "excludeFolderMissing");
});

test("resolveScope: 排除目录写绝对路径 → 报 excludeFolderAbsolute", () => {
    const scope = resolveScope(
        settingsWith({ excludeFolders: "/assets" }),
        vaultWith(["assets/a.png"]),
    );
    assert.equal(scope.ok, false);
    assert.equal(scope.errors[0].key, "excludeFolderAbsolute");
});

test("resolveScope: 目录存在时存的是 vault 里的规范写法", () => {
    const scope = resolveScope(
        settingsWith({ includeFolders: "assets//img/", excludeFolders: "assets/img/keep" }),
        vaultWith(["assets/img/a.png", "assets/img/keep/b.png"]),
    );
    assert.equal(scope.ok, true);
    assert.deepEqual(scope.includeFolders, ["assets/img"]);
    assert.deepEqual(scope.excludeFolders, ["assets/img/keep"]);
});

test("resolveScope: 清理目录整体位于排除目录内 → 报 includeFolderShadowed，而不是静默无结果", () => {
    const scope = resolveScope(
        settingsWith({ includeFolders: "assets/img", excludeFolders: "assets" }),
        vaultWith(["assets/img/a.png"]),
    );
    assert.equal(scope.ok, false);
    const shadowed = scope.errors.filter((e) => e.key === "includeFolderShadowed");
    assert.equal(shadowed.length, 1, "同一个目录只报一次，不要把每个祖先都念一遍");
    assert.equal(shadowed[0].params.path, "assets/img");
    assert.equal(shadowed[0].params.other, "assets");
});

test("resolveScope: 多个排除目录同时覆盖同一个清理目录也只报一条", () => {
    const scope = resolveScope(
        settingsWith({ includeFolders: "assets/img", excludeFolders: "assets\nassets/img" }),
        vaultWith(["assets/img/a.png"]),
    );
    const shadowed = scope.errors.filter((e) => e.key === "includeFolderShadowed");
    assert.equal(shadowed.length, 1);
});

test("resolveScope: 排除目录嵌在清理目录内是正常配置，不报错", () => {
    const scope = resolveScope(
        settingsWith({ includeFolders: "assets", excludeFolders: "assets/keep" }),
        vaultWith(["assets/a.png", "assets/keep/b.png"]),
    );
    assert.equal(scope.ok, true);
});

test("resolveScope: 留空清理目录 + 排除仓库根 → 判定为自相矛盾", () => {
    const scope = resolveScope(
        settingsWith({ excludeFolders: "/" }),
        vaultWith(["assets/a.png"]),
    );
    assert.equal(scope.ok, false);
    assert.ok(scope.errors.some((e) => e.key === "includeFolderShadowed"));
});

test("resolveScope: 扩展名只填 md → 全被拒后按 extensionsEmpty 中止", () => {
    const scope = resolveScope(
        settingsWith({ extensions: "md" }),
        vaultWith(["note.md"]),
    );
    assert.equal(scope.ok, false);
    assert.ok(scope.errors.some((e) => e.key === "extensionsEmpty"));
    assert.deepEqual(scope.rejectedExtensions, ["md"]);
});

test("resolveScope 能报出的每个错误键在两种语言里都有非空文案", () => {
    // includeFolder* / excludeFolder* 这几个键是用 `${prefix}Absolute` 拼出来的，
    // 静态搜索找不到，改名时最容易漏 —— 漏了 Notice 就是一片空白。
    const vault = vaultWith(["assets/a.png", "assets/img/b.png"]);
    const cases = [
        { includeFolders: "/abs" },
        { includeFolders: "missing" },
        { includeFolders: "assets/a.png" },
        { excludeFolders: "/abs" },
        { excludeFolders: "missing" },
        { excludeFolders: "assets/a.png" },
        { extensions: "" },
        { includeFolders: "assets/img", excludeFolders: "assets" },
    ];
    const seen = new Set();
    for (const patch of cases) {
        const scope = resolveScope(settingsWith(patch), vault);
        assert.equal(scope.ok, false, JSON.stringify(patch));
        for (const problem of scope.errors) seen.add(problem.key);
        for (const problem of scope.errors) {
            for (const option of LANGUAGE_OPTIONS) {
                const message = localizedError(option, problem.key, problem.params);
                assert.ok(message.length > 0, `${problem.key} (${option.value}) 文案为空`);
                assert.ok(
                    !message.includes("{"),
                    `${problem.key} (${option.value}) 有占位符没填：${message}`,
                );
            }
        }
    }
    assert.deepEqual([...seen].sort(), [
        "excludeFolderAbsolute",
        "excludeFolderMissing",
        "excludeFolderNotFolder",
        "extensionsEmpty",
        "includeFolderAbsolute",
        "includeFolderMissing",
        "includeFolderNotFolder",
        "includeFolderShadowed",
    ], "全部拒绝理由都要被覆盖到");
});

test("resolveScope: 多行都写错时一次性报出全部问题", () => {
    const scope = resolveScope(
        settingsWith({ includeFolders: "/abs\nmissing", excludeFolders: "also-missing" }),
        vaultWith(["assets/a.png"]),
    );
    assert.equal(scope.ok, false);
    assert.deepEqual(
        scope.errors.map((e) => e.key),
        ["includeFolderAbsolute", "includeFolderMissing", "excludeFolderMissing"],
    );
});
