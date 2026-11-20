이 논문의 표기 규약 카드를 만든다. 아래 11개 key마다 <item> 정확히 하나씩, 이 순서로, 각 item을 줄 처음에서
시작해 쓴다. item 밖에는 아무것도 쓰지 않는다.

<item key="frame_notation" label="P">본문</item>

key: frame_notation(좌표계 표기), transform_direction(변환 방향 T_AB의 뜻), rotation_param(회전 표현),
quaternion_convention(쿼터니언 규약: Hamilton/JPL, 순서), perturbation_side(섭동 방향: 좌/우), error_definition(오차
정의), state_vector(상태 벡터 구성), jacobian_convention(자코비안 규약), gravity_sign(중력 부호), time_notation(시간
표기), units(단위)

- label은 P(논문에 명시 — 본문에 <q> 인용 또는 <eq n="번호"/> 필수), N(논문에 명시 없음 — 추정이면 그렇게
  밝힌다), G(일반 관례) 중 하나다.
- 본문은 1–3문장 SP-Markup이다. 본문 안에 [[P]] 같은 라벨을 쓰지 않는다(라벨은 label 속성뿐).
- 속성은 key와 label만 쓴다. 같은 item 안에 다른 <item>을 넣지 않는다.
