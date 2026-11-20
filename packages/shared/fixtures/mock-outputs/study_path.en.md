## 1

Start with two scans. Point-to-point ICP pairs nearby points and estimates the change in pose that reduces the distance between the pairs. [[G]]

## 2

Keep a spatial index of the target. Move the scan into its frame, find the nearest points, then update the pose. A poor initial pose can match the wrong wall. A wide search radius can accept moving objects. [[G]]

## 3

When reading KISS-ICP, follow the link between the residual and the pose update. The synthetic exercise states that link explicitly. <q>We estimate the robot pose by minimizing the point-to-point residual between consecutive scans.</q> [[P]]

Use the actual paper to check which parts of its thresholding scheme differ from this exercise. [[G]]

## 4

Open <eq n="1"/>. In our translation-only example, $p$ is a scan point and $q$ is its match. Their difference after applying $t$ is $p+t-q$. [[G]]

## 5

First, give both lists of points and a radius in metres to the correspondence search. Return the offset for each accepted pair. The point at 50 m should have no neighbour within 0.3 m. [[G]]

{{example_1}}

Next, average the offsets to estimate a translation. The input below leaves two pairs and gives 0.1 m along x. Skip the update for an empty set. This one-step example omits rotation, iterative convergence and robust weights. [[G]]

{{example_2}}

## 6

Why does the far point have no match? What happens if the search radius is only 0.05 m?

- [ ] Check that points outside the radius are excluded
- [ ] Check that the translation from the remaining pairs is 0.1 m

## 7

Open the first listed reference and compare its correspondence rule with the one in the small example. [[G]]

- [ref:1]
