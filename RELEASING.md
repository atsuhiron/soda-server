# リリース手順

「vX.Y.Z を公開して」と頼まれたときに行う作業です。公開そのものは `v*` タグの push で `.github/workflows/release.yml` が行いますが、その前に CHANGELOG と package.json のバージョンをそろえ、PR を通しておきます。

## バージョン番号の決め方

[セマンティック バージョニング](https://semver.org/lang/ja/) に従います。1.0.0 までの目安:

| 上げる桁 | どんな変更か |
|---|---|
| Y(マイナー) | 新しい機能、新しい飲み物やグラス、**物理パラメータの校正値の変更**(同じ注ぎ方でもタイムやこぼれが変わり、過去の記録と比べられなくなるため) |
| Z(パッチ) | 不具合の修正、見た目や文言の調整など、記録に影響しない変更 |

## 0. 始める前の確認

- [ ] 指定された `vX.Y.Z` がセマンティック バージョニングの形式で、既存のタグ(`git tag --list 'v*'`)より大きく、まだ存在しない
- [ ] `main` が最新で、作業ツリーがきれい(`git switch main && git pull`、`git status`)
- [ ] `main` の最新コミットで CI が通っている
- [ ] CHANGELOG の「未リリース」に今回公開する変更がそろっている。足りなければ `git log <前回のタグ>..main` と PR 一覧から補い、内容を依頼者に確認する
- [ ] 初回のみ: GitHub の設定が済んでいる(Settings → Pages の Source が **GitHub Actions**、Settings → Environments → `github-pages` にタグのルール `v*`)

ひとつでも満たさなければ、そこで止めて依頼者に報告する。

## 1. リリース用の PR を作る

ブランチ `release/vX.Y.Z` を `main` から切り、次を更新する。

1. **CHANGELOG.md**
   - 「未リリース」の内容を新しい見出し `## [X.Y.Z] - YYYY-MM-DD`(公開日)へ移し、「未リリース」は空にして残す
   - 末尾のリンクを更新する
     - `[未リリース]: https://github.com/atsuhiron/soda-server/compare/vX.Y.Z...main`
     - `[X.Y.Z]: https://github.com/atsuhiron/soda-server/compare/v前回...vX.Y.Z`(初回は `https://github.com/atsuhiron/soda-server/releases/tag/vX.Y.Z`)
2. **package.json** の `"version"` を `X.Y.Z` にする
3. 物理パラメータの校正値を変えたリリースでは、過去のベスト記録と比べられなくなる。`js/main.js` の `BEST_KEY` の末尾番号を上げるかどうかを依頼者に確認する

公開ページのバージョン表記(タイトルの横)は書き換えなくてよい。`index.html` には「開発版」と書いてあり、公開のときに `release.yml` がタグ名(`vX.Y.Z`)に置き換える。置き換える場所の目印 `<!--VERSION-->…<!--/VERSION-->` は消さない(見つからないと公開が止まる)。

`npm test` が通ることを確かめ、コミット `vX.Y.Z をリリース` を作り、PR を出す。CI が通ったら、マージは依頼者に頼む。

## 2. タグを付けて公開する

PR がマージされたら:

```
git switch main
git pull
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
```

タグは必ずマージ後の `main` の先頭に付ける。

## 3. 公開を確認する

- [ ] Release ワークフローが成功した(`gh run list --workflow release.yml --limit 1`)
- [ ] https://atsuhiron.github.io/soda-server/ が開き、ゲームが動く。タイトルの横のバージョン表記が `vX.Y.Z` になっている
- [ ] GitHub Release を作る。本文には CHANGELOG の `[X.Y.Z]` の節をそのまま使う(`gh release create vX.Y.Z --title "vX.Y.Z" --notes-file <その節を書き出したファイル>`)

## 失敗したとき

- **テストで止まった / 公開に失敗した**: タグは消さずに原因を直し、新しいパッチ版(`vX.Y.Z+1`)として出し直す。公開済みのタグを付け替えない
- **タグからの公開が拒否された**: `github-pages` 環境のタグのルール `v*` を確認し、Actions の画面からワークフローを再実行する
