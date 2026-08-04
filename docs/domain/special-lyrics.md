# Synthesizer V 2 特殊歌词语义

本文定义 SV Copilot 当前对 `+`、`-`、`br`、歌词前缀 `'` 和音素 `cl` 的统一解释。
实现权威位于 `server/src/vocal-event-semantics.js`，回归位于
`test/vocal-event-semantics.test.mjs`。

## 1. 分类

| 原始输入 | 语义角色 | 默认进入旋律分析 | 消耗歌词单元 |
|---|---|---:|---:|
| 普通歌词 | `lexical_head` | 是 | 是 |
| `+` | `syllable_continuation` | 有合法前序链时是 | 否 |
| `-` | `phonation_continuation` | 有活动发音时是 | 否 |
| `br` | `breath_event` | 否 | 否 |
| 长度大于 1 且以 `'` 开头 | `glottal_onset` | 是 | 是 |
| 单独 `'` | `unknown_special` | 否 | 否 |

匹配严格保留原始输入：只有 ASCII `+`、`-`、`'` 和小写 `br` 具有正式特殊语义。
`BR`、全角符号或弯引号不被静默规范化，而是保留为普通歌词并返回
`SUSPICIOUS_SPECIAL_LYRIC_VARIANT`。

歌词前缀 `'` 与音素 `cl` 不是同一个字段。前者是歌词语法，后者只在音素观测中形成
`glottal_phoneme` feature；歌词文本恰为 `cl` 仍是普通 lexical input。

## 2. Continuation 状态机

状态只在同一 NoteGroup 内延续：

```text
lexical_head / glottal_onset
  -> 建立 lexical head 与 active pronunciation
+ -> 推进 syllable ordinal
- -> 延长当前 active pronunciation
br / unknown_special
  -> 关闭当前链
```

对应问题码：

| 代码 | 含义 |
|---|---|
| `ORPHAN_PLUS` | `+` 前没有 lexical head |
| `ORPHAN_PHONATION_CONTINUATION` | `-` 前没有活动发音 |
| `SYLLABLE_CHAIN_GAP` | `+` 与前一链事件之间存在正间隙 |
| `SYLLABLE_CHAIN_OVERLAP` | `+` 与前一链事件发生重叠 |

gap/overlap 是质量 warning，不会把已有合法 lexical chain 改成未处理状态。孤立 `+`/`-`
不能进入调性、音域或表现规划。

## 3. `br` 的边界

`br` 是官方文档定义的呼吸事件，不是 Breathiness 参数，也不是普通 MIDI 旋律音。
高层旋律分析和默认音高规划会排除它，但显式低层写入能力不能仅因这一音乐偏好被禁止。

以下推断均不成立：

- computed pitch 为 `null` 就一定是呼吸；
- `br` 一定返回 `null` computed pitch；
- PitchControl 对所有声库的 `br` 都可闻或都不可闻；
- 音素数组包含 `br` 就应排除整个混合发音音符。

## 4. 处理完成与内容覆盖

音素数组已经为每个音符返回项目时，处理可以是 `ready`；合法的空字符串不表示 pending。
`computedItems` 与 `expectedNotes` 描述完成度，`nonEmptyPhonemes` 描述内容覆盖率，两个维度不能
混为一个状态。

## 5. 证据来源

- Dreamtonics：<https://sv2.docs.dreamtonics.com/zh/enter-notes>
- Dreamtonics：<https://sv2.docs.dreamtonics.com/en/enter-notes>

官方资料支持 `+`、`-`、`br` 和 apostrophe 前缀的基础语义；standalone apostrophe、混合
`br` phoneme、特定声库听感和 PitchControl 可闻性仍需宿主或人工证据。
