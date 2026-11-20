<card type="definition" highlight="h1">
<front>이 논문의 pose 추정은 무엇을 최소화하는가?</front>
<back>연속한 scan 사이의 point-to-point residual.</back>
<q>We estimate the robot pose by minimizing the point-to-point residual between consecutive scans.</q>
</card>
<card type="why" highlight="h2">
<front>robust kernel을 쓰는 이유는?</front>
<back>residual의 outlier 가중치를 줄이기 위해.</back>
<q>The robust kernel down-weights outliers in the residual.</q>
</card>
