## 기호 표

| 기호 | 의미 | 차원·공간 | frame·단위 | 근거 |
|---|---|---|---|---|
| $r_i$ | i번째 점의 residual | $\mathbb{R}^3$ | target frame, m | <eq n="1"/> [[P]] |
| $R$ | 회전 행렬 | $SO(3)$ | source → target | 논문에 명시 없음 [[N]] |

## 단계별 유도

1. 출발 식: $r_i = R p_i + t - q_i$ (<eq n="1"/>). [[P]]
2. (논문 생략) 제곱합 $\sum_i \lVert r_i \rVert^2$을 최소화한다고 가정한다. [[N]]
3. 추정한 상대 변환은 pose 누적 <eq n="2"/>에 들어간다. [[P]]

## 쓰인 가정

- 대응점 $q_i$는 고정 임계값으로 고른다: <q>The data association uses a fixed threshold of 0.5 m and a robust kernel.</q> [[P]]

## 확인 질문

1. $R$이 source → target 방향인지 논문에서 어떻게 확인할 수 있는가? [[N]]
