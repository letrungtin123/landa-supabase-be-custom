// ============================================================
// ENTROPY UTILS - Tính Shannon Entropy cho chuỗi
// ============================================================
// Shannon entropy đo mức "hỗn loạn" trong chuỗi
// Chuỗi lặp 1 ký tự (vd: "aaaaaaa") => entropy rất thấp (~0)
// Chuỗi ngôn ngữ tự nhiên => entropy thường từ 3.0 - 5.0

/**
 * Tính Shannon entropy cho một chuỗi
 *
 * Công thức: H = -Σ p(x) * log2(p(x))
 * Trong đó p(x) là xác suất xuất hiện của ký tự x
 *
 * @param text - Chuỗi cần tính entropy
 * @param debug - Bật/tắt console.log
 * @returns Giá trị entropy (0 = hoàn toàn đồng nhất, cao = đa dạng)
 */
export function calculateShannonEntropy(text: string, debug: boolean = false): number {
    // Chuỗi rỗng hoặc 1 ký tự => entropy = 0
    if (text.length <= 1) {
        return 0;
    }

    // Bước 1: Đếm tần suất xuất hiện của mỗi ký tự
    const frequencyMap: Map<string, number> = new Map();
    for (const char of text) {
        const currentCount = frequencyMap.get(char);
        if (currentCount !== undefined) {
            frequencyMap.set(char, currentCount + 1);
        } else {
            frequencyMap.set(char, 1);
        }
    }

    // Bước 2: Tính entropy từ tần suất
    const totalChars = text.length;
    let entropy = 0;

    for (const count of frequencyMap.values()) {
        // Tính xác suất xuất hiện
        const probability = count / totalChars;

        // Cộng dồn: -p * log2(p)
        if (probability > 0) {
            entropy -= probability * Math.log2(probability);
        }
    }

    if (debug) {
        console.log(`[entropy] Text length=${totalChars}, unique chars=${frequencyMap.size}, entropy=${entropy.toFixed(4)}`);
    }

    return entropy;
}
