var lengthOfLongestSubstring = function(s) {
    let arr = new Array(128).fill(false);
    let l = 0, r = 0, maxLen = 0;

    while (r < s.length) {
        if (!arr[s.charCodeAt(r)]) {
            arr[s.charCodeAt(r)] = true;
            maxLen = Math.max(maxLen, r - l + 1);
            r++;
        } else {
            arr[s.charCodeAt(l)] = false;
            l++;
        }
    }
    return maxLen;
};