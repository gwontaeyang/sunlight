## 3줄 요약

- point-to-point residual을 최소화해 pose를 추정한다: <q>We estimate the robot pose by minimizing the point-to-point residual between consecutive scans.</q> [[P]]
- 고정 임계값 data association과 robust kernel을 쓴다. [[P]] 
- 단일 CPU core에서 10 Hz로 동작한다: <q>The method runs at 10 Hz on a single CPU core.</q> [[P]]

## 방법 요약

residual은 <eq n="1"/>, pose 누적은 <eq n="2"/>로 정의된다. [[P]]

## 읽기 지도

I절을 먼저 읽고 II절의 robust kernel 설명으로 넘어간다. [[N]]
