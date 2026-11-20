이 논문이 기대는 가정과 한계를 카드로 정리한다. 가정 하나마다 <item>을 줄 처음에서 시작해 쓴다(1–40개).
item 밖에는 아무것도 쓰지 않는다.

<item category="motion" label="P">본문</item>
<item category="limitation" stated="author" label="P">본문</item>

- category: sensor, motion, environment, initialization, time_sync, observability, computation, limitation 중 하나.
- limitation item에만 stated를 쓴다: author(저자가 밝힘) 또는 inferred(네가 추론). 다른 category에는 쓰지 않는다.
- label은 P(논문에 명시 — 본문에 <q> 인용 필수), N(논문에 명시 없음, 추론), G(일반 지식) 중 하나.
- 본문은 1–3문장 SP-Markup: 가정의 내용과, 그 가정이 깨지면 무엇이 잘못되는지. 본문 안에 라벨을 쓰지 않는다.
- 속성은 category, label, stated만 쓴다. 같은 item 안에 다른 <item>을 넣지 않는다.
