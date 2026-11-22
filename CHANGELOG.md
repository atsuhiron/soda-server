# 変更履歴

このプロジェクトの主な変更を記録します。
書式は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/)、バージョン番号は [セマンティック バージョニング](https://semver.org/lang/ja/) に従います。
変更を入れる PR では、下の「未リリース」に 1 行ずつ追記してください。公開の手順は [RELEASING.md](RELEASING.md) にあります。

## [未リリース]

### 追加

- 炭酸飲料をなるべく速く、こぼさずにコップへ注ぐブラウザゲーム。泡の挙動は `soda_foam_physics_report.md` の §9 L1 モデル(CO₂ 収支・気泡集団・泡層 ODE)で計算する (#1)
- 2 軸マウス操作(ボトルの傾き・グラスの傾き)、注ぎ口の高さ、飲み物 5 種・グラス 4 種などの自由設定、記録グラフと CO₂ の行き先の表示 (#1)
- 物理エンジンの単体テスト、校正スクリプト `npm run calibrate`、静的サーバー `npm start` (#1)
- PR ごとに全 JS ファイルの構文チェックと単体テストを実行する CI (#2)
- `v*` タグの push で GitHub Pages に公開するワークフロー (#2)

[未リリース]: https://github.com/atsuhiron/soda-server/commits/main
