/*
 * DNS redirect preload library for headless MITM interception.
 *
 * Hooks getaddrinfo() via DYLD_INSERT_LIBRARIES (macOS) or LD_PRELOAD (Linux)
 * to redirect Google API domain resolution to 127.0.0.1, so the LS binary
 * connects to our local MITM proxy instead of the real Google servers.
 *
 * Build (macOS): cc -shared -fPIC -o dns_redirect.dylib dns_redirect.c
 * Build (Linux): gcc -shared -fPIC -o dns_redirect.so dns_redirect.c -ldl
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
