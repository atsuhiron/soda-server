# soda-server

炭酸飲料をこぼさず速く注ぐブラウザゲーム。物理エンジンは `js/physics.js`、遊び方と構成は README.md を参照。

## 変更を入れるとき

- 利用者から見える変更は CHANGELOG.md の「未リリース」に 1 行追記する(PR 番号つき)
- 物理を触ったら `npm test` と `npm run calibrate` で傾向が崩れていないか確認する

## 「vX.Y.Z を公開して」と言われたら

RELEASING.md の手順に上から順に従う。タグを push するだけでは済まない(CHANGELOG・package.json の更新と、リリース用 PR のマージが先)。公開ページのバージョン表記は、公開時にワークフローがタグ名から書き込む。
