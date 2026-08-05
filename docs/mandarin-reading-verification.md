# Mandarin Reading Verification

`sv_validate_lyrics_prosody` 的 `mandarinReading` check 读回 range context 中保存的宿主
G2P 音素，并把 122 个常见多音字对应的 X-SAMPA 精确反查为无调拼音。它只供人工确认，
不会修改歌词、音素或 `sv_align_lyrics` 的规划行为。

## 调用流程

先捕获音符与 processing：

```json
{
  "operation": "snapshot_range",
  "arguments": {
    "scope": {
      "kind": "range",
      "from": { "bar": 1 },
      "to": { "bar": 5 }
    },
    "include": ["notes", "processing"]
  }
}
```

再对返回的 `contextId` 执行：

```json
{
  "operation": "check_prosody",
  "arguments": {
    "contextId": "c_example",
    "checks": ["mandarinReading"]
  }
}
```

命中项以 info finding 返回宿主原始音素和反查结果。例如歌词“还”的
`hostPhonemes: "x a :\\i"` 对应 `hostReading: "hai"`，
`hostPhonemes: "x ua :n"` 对应 `hostReading: "huan"`。

## 结果边界

- 拼音格式是 `toneless_ascii_v`，即无声调 ASCII 拼音，`v` 表示 `ü`。
- 只能区分声母或韵母不同的读音，无法区分仅声调不同的多音读法。
- 查表采用精确匹配。未识别的宿主格式返回 `unknown_phoneme_format`，不会规范化或猜测。
- 有候选多音字但命中率为零时，响应包含 `MANDARIN_READING_ZERO_HIT_RATE`，表示当前
  宿主格式尚未通过该查表验证。
- 缺少 processing、旧 context 未保存逐音符字符串、或宿主处理仍 pending 时，check 分别
  返回可区分的降级状态并提示重新捕获。

数据来源、原表重复项的处理和再分发边界记录在 `THIRD_PARTY_NOTICES.md`。
