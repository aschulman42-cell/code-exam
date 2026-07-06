/*
 * logging.c - Structured logging for secure connection subsystem
 *
 * Thread-safe logging with severity levels and timestamps.
 *
 * Copyright (c) 2024 SecureNet Systems, Inc.
 */

#include <stdio.h>
#include <stdarg.h>
#include <time.h>
#include <pthread.h>
#include "logging.h"

#define LOG_BUF_SIZE  1024

static FILE *log_file = NULL;
static int   log_level = LOG_INFO;
static pthread_mutex_t log_mutex = PTHREAD_MUTEX_INITIALIZER;

static const char *level_names[] = {
    "ERROR", "WARN", "INFO", "DEBUG"
};


void log_init(const char *filename, int level)
{
    if (filename != NULL) {
        log_file = fopen(filename, "a");
    }
    if (log_file == NULL) {
        log_file = stderr;
    }
    log_level = level;
}

void log_error(const char *fmt, ...)
{
    va_list args;
    va_start(args, fmt);
    log_write(LOG_ERROR, fmt, args);
    va_end(args);
}

void log_warn(const char *fmt, ...)
{
    va_list args;
    va_start(args, fmt);
    log_write(LOG_WARN, fmt, args);
    va_end(args);
}

void log_info(const char *fmt, ...)
{
    va_list args;
    va_start(args, fmt);
    log_write(LOG_INFO, fmt, args);
    va_end(args);
}

void log_debug(const char *fmt, ...)
{
    va_list args;
    va_start(args, fmt);
    log_write(LOG_DEBUG, fmt, args);
    va_end(args);
}

void log_write(int level, const char *fmt, va_list args)
{
    char buf[LOG_BUF_SIZE];
    time_t now;
    struct tm *tm_info;

    if (level > log_level) return;

    time(&now);
    tm_info = localtime(&now);

    pthread_mutex_lock(&log_mutex);

    fprintf(log_file, "%04d-%02d-%02d %02d:%02d:%02d [%s] ",
            tm_info->tm_year + 1900, tm_info->tm_mon + 1,
            tm_info->tm_mday, tm_info->tm_hour,
            tm_info->tm_min, tm_info->tm_sec,
            level_names[level]);

    vfprintf(log_file, fmt, args);
    fprintf(log_file, "\n");
    fflush(log_file);

    pthread_mutex_unlock(&log_mutex);
}

void log_close(void)
{
    if (log_file != NULL && log_file != stderr) {
        fclose(log_file);
        log_file = NULL;
    }
}
