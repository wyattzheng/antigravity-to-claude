/*
 * DNS redirect + TLS trust bypass preload library for MITM interception.
 *
 * Two hooks:
 *   1. getaddrinfo() — redirect Google API domains to 127.0.0.1
 *   2. SecTrustEvaluateWithError() — bypass macOS cert verification
 *      (only affects the injected process, not system-wide)
 *
 * Build (macOS):
 *   cc -shared -fPIC -o dns_redirect.dylib dns_redirect.c \
 *      -framework Security -framework CoreFoundation
 *
 * Build (Linux):
 *   gcc -shared -fPIC -o dns_redirect.so dns_redirect.c -ldl
 */

#include <dlfcn.h>
#include <netdb.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <string.h>
#include <stdlib.h>
#include <stdio.h>

/* Google API domains whose DNS resolution should be redirected to 127.0.0.1 */
static const char *REDIRECT_DOMAINS[] = {
    "daily-cloudcode-pa.googleapis.com",
    "cloudcode-pa.googleapis.com",
    "autopush-cloudcode-pa.googleapis.com",
    NULL
};

typedef int (*getaddrinfo_t)(const char *, const char *,
                             const struct addrinfo *, struct addrinfo **);

static int should_redirect(const char *host) {
    if (!host) return 0;
    for (int i = 0; REDIRECT_DOMAINS[i]; i++) {
        if (strcmp(host, REDIRECT_DOMAINS[i]) == 0) return 1;
    }
    return 0;
}

int getaddrinfo(const char *node, const char *service,
                const struct addrinfo *hints, struct addrinfo **res) {
    getaddrinfo_t real_getaddrinfo =
        (getaddrinfo_t)dlsym(RTLD_NEXT, "getaddrinfo");

    if (should_redirect(node)) {
        /* Resolve to localhost — the MITM proxy is listening there */
        return real_getaddrinfo("127.0.0.1", service, hints, res);
    }

    return real_getaddrinfo(node, service, hints, res);
}

/*
 * macOS only: hook Security.framework cert verification.
 * Go's crypto/x509 on macOS calls SecTrustEvaluateWithError() via cgo
 * to verify TLS certificates. By overriding it, we make the Go binary
 * accept our self-signed MITM cert without touching the system keychain.
 */
#ifdef __APPLE__
#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>

/* Override SecTrustEvaluateWithError — always return true (trusted) */
bool SecTrustEvaluateWithError(SecTrustRef trust, CFErrorRef *error) {
    if (error) *error = NULL;
    return true;
}

/* Override the older SecTrustEvaluate too, for compatibility */
OSStatus SecTrustEvaluate(SecTrustRef trust, SecTrustResultType *result) {
    if (result) *result = kSecTrustResultProceed;
    return errSecSuccess;
}
#endif
