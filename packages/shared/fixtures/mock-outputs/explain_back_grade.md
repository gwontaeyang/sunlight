<verdict score="60">핵심은 맞지만 data association 임계값을 틀리게 적었다.</verdict>
<point status="correct">
<claim>point-to-point residual을 최소화해 pose를 추정한다.</claim>
<fix>-</fix>
<q>We estimate the robot pose by minimizing the point-to-point residual between consecutive scans.</q>
</point>
<point status="wrong">
<claim>임계값은 1 m이다.</claim>
<fix>임계값은 0.5 m이다.</fix>
<q>The data association uses a fixed threshold of 0.5 m and a robust kernel.</q>
</point>
<point status="missing">
<claim>deskew 단계</claim>
<fix>matching 전에 constant velocity model로 deskew한다.</fix>
<q>Each scan is deskewed with a constant velocity model before matching.</q>
</point>
<followup>deskew를 하지 않으면 residual에 어떤 영향이 생기는가?</followup>
