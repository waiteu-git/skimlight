"""rule-audit: 自分に関わる規則（コンテスト要項・奨学金の募集要項・自治体の制度）を、原文つきで見落としなく読む道具。

配置:
  textnorm / vocab / quotes  引用の逐語照合（照合済みを決める唯一の場所＝quotes）
  snapshot                   原文の取得（GET のみ）と控え。本人の状況には触れない
  situation                  本人の状況（端末の JSON）。ネットワークに触れない
  cards                      要件カードの読み込み
  adjudicate                 3値（引用あり／引用なし／要確認）を決める唯一の場所
  watch                      差分監視
  report / cli               文面と CLI
"""
