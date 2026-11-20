## 1

두 번 찍은 점구름을 겹쳐 보면 센서가 어디로 움직였는지 알 수 있어요. Point-to-point ICP는 한쪽 점을 다른 쪽에서 가까운 점과 짝짓고, 그 거리를 줄이는 변환을 찾습니다. [[G]]

## 2

보통 기준 점들을 공간 색인에 넣고 현재 자세로 스캔을 옮긴 뒤 이웃을 질의해요. 짝을 고르고 자세를 고친 다음 다시 짝을 고르는 게 한 바퀴예요. 출발 자세가 나쁘면 다른 벽에 붙을 수 있고, 거리 기준이 너무 넓으면 움직이는 물체도 짝이 됩니다. [[G]]

## 3

KISS-ICP를 읽을 때는 먼저 대응점 오차가 어떻게 자세 추정으로 이어지는지 보세요. 이 연습에 쓰는 합성 문서도 이 연결을 한 문장으로 보여 줘요. <q>We estimate the robot pose by minimizing the point-to-point residual between consecutive scans.</q> [[P]]

실제 KISS-ICP와 합성 예제의 차이는 따로 남겨 두세요. 어떤 임계값을 적응적으로 바꾸는지, 그 변화가 앞의 잘못된 대응을 줄이는지는 실제 논문과 대조할 질문이에요. [[G]]

## 4

이 예제에서는 점을 옮긴 뒤 기준점까지 남은 차이를 잔차로 읽으면 됩니다. 색인의 <eq n="1"/>부터 열어 보세요. $p$가 스캔의 점, $q$가 짝이 된 기준점이면, 이동 $t$를 적용한 뒤의 차이는 $p+t-q$예요. 회전은 여기서 생략했어요. [[G]]

## 5

첫 단계에서는 두 점 목록과 허용 거리(미터)를 받아 대응점까지의 변위 목록을 만들어요. 50 m에 있는 점은 0.3 m 이내에 이웃이 없으니 출력에 들어가지 않아야 합니다. 예제를 작게 두려고 공간 색인 대신 전체 점을 훑어요. [[G]]

```cpp
#include <Eigen/Core>
#include <cassert>
#include <vector>

using Points = std::vector<Eigen::Vector2d>;

Points correspond(const Points& scan, const Points& map,
                  double radius) {
    Points offsets;
    for (const auto& p : scan) {
        const Eigen::Vector2d* best = nullptr;
        double limit = radius * radius;
        for (const auto& q : map) {
            double d2 = (q - p).squaredNorm();
            if (d2 <= limit) { best = &q; limit = d2; }
        }
        if (best) offsets.push_back(*best - p);
    }
    return offsets;
}
```

두 번째 단계에서는 변위 목록을 평균 내서 평행이동을 구합니다. 아래 좌표를 쓰면 두 쌍만 남고 $x$ 방향으로 0.1 m가 나와요. 대응점이 없는 경우에는 갱신을 건너뛰어야 해요. 이 예제는 한 번의 이동만 다루므로 회전·반복 수렴·강건 가중치는 별도 구현 대상입니다. [[G]]

```cpp
int main() {
    Points scan{{0, 0}, {2, 0}, {50, 0}};
    Points map{{0.1, 0}, {2.1, 0}};
    const auto offsets = correspond(scan, map, 0.3);
    assert(offsets.size() == 2);
    Eigen::Vector2d t = Eigen::Vector2d::Zero();
    for (const auto& d : offsets) t += d;
    t /= static_cast<double>(offsets.size());
    assert((t - Eigen::Vector2d(0.1, 0)).norm() < 1e-9);
}
```

## 6

어째서 마지막 점은 짝이 없을까요? 반경을 0.05 m로 줄이면 이번에는 어떤 자세 갱신이 가능할까요?

- [ ] 반경 밖의 점이 대응 목록에서 빠지는지 확인하기
- [ ] 남은 두 쌍으로 구한 이동이 0.1 m인지 확인하기

## 7

참고문헌의 첫 항목을 열고 어떤 거리 기준으로 점의 짝을 정하는지 비교해 보세요. 여기서 쓰는 작은 예제의 전제를 다시 볼 수 있어요. [[G]]

- [ref:1]
