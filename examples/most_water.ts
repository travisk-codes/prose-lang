function maxArea(height: number[]): number {
    let n = height.length;
    let most = 0;
    let left = 0, right = n - 1;
    while (left !== right) {
        let area = (right - left) * Math.min(height[left], height[right]);
        most = Math.max(area, most);
        if (height[left] <= height[right]) {
            left++;
        } else {
            right--;
        }
    }
    return most;
};
