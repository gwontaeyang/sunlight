**한 줄 요지:** 연속한 두 scan 사이의 point-to-point residual(점-점 잔차)을 최소화해 robot pose를 추정한다는 문장이다. [[P]]

논문은 이 추정을 <q>We estimate the robot pose by minimizing the point-to-point residual between consecutive scans.</q>라고 적고, 잔차의 정의는 <eq n="1"/>이다. [[P]]

data association(데이터 연관)에는 고정 임계값과 robust kernel을 함께 쓴다: <q>The data association uses a fixed threshold of 0.5 m and a robust kernel.</q> [[P]]

일반적으로 robust kernel은 큰 잔차의 가중치를 줄여 outlier의 영향을 낮춘다. [[G]]

<glossary><term name="robust kernel">큰 잔차의 가중치를 줄이는 손실 함수</term></glossary>
