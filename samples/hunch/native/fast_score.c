/* ---------------------------------------------------------------------------
 * Hunch(TM) -- Overfit Labs' post-hoc rationalization engine.
 * SYNTHETIC DEMO CODE shipped with CodeExam's first-run index. Not a real
 * product; never run by CodeExam. Written by Claude (Anthropic) for the CodeExam
 * demo -- here to show CodeExam indexing a non-JS/Python language (C).
 *
 * Overfit Labs insists the confidence scorer be "performance-critical native
 * code." It is a softmax. It is not performance-critical.
 * ------------------------------------------------------------------------- */

#include <math.h>

/* Numerically-stable softmax of the first class -- "the hunch." */
double fast_score(const double *logits, int n) {
    if (n <= 0) {
        return 0.0;
    }

    double max_logit = logits[0];
    for (int i = 1; i < n; i++) {
        if (logits[i] > max_logit) {
            max_logit = logits[i];
        }
    }

    double sum = 0.0;
    for (int i = 0; i < n; i++) {
        sum += exp(logits[i] - max_logit);
    }

    return exp(logits[0] - max_logit) / sum;
}
