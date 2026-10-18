import {
  Catch,
  HttpException,
  type ArgumentsHost,
  type ExceptionFilter,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { ZodError } from "zod";
import { DockerManagementConflict } from "../../docker/docker-management.models.js";
import {
  DockerLogsPolicyError,
  DockerLogsProtocolError,
  DockerLogsSequenceError,
  DockerLogsSubscriptionMissingError,
} from "../../docker/docker-logs.service.js";
import {
  AgentAuthError,
  DemoMutationBlockedError,
  DemoSshDisabledError,
  DuplicateAgentInstallError,
  SshHostBlockedError,
  SshHostKeyScanFailedError,
  SshHostKeyTrustRequiredError,
  SshOperationError,
  VpsNotFoundError,
} from "../errors.js";
import { safeErrorMessage } from "../redaction.js";
import { FilesError } from "../../files/files-error.js";

function errorBody(
  message: string,
  _requestId?: string,
  extra?: Record<string, string>,
) {
  return { error: { message, ...extra } };
}

export class ApiExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const request = host.switchToHttp().getRequest<Request>();
    const response = host.switchToHttp().getResponse<Response>();
    const requestId = request.requestId;

    if (error instanceof ZodError) {
      return response.status(400).json(errorBody("Invalid request", requestId));
    }

    if (error instanceof VpsNotFoundError) {
      return response.status(404).json(errorBody("VPS not found", requestId));
    }

    if (error instanceof FilesError) {
      return response.status(error.status).json({
        error: {
          code: error.code,
          message: error.message,
        },
      });
    }

    if (error instanceof DockerManagementConflict) {
      return response.status(409).json(errorBody("Docker management operation conflict", requestId));
    }

    // Realtime log broker errors: safe codes only, never caller input.
    if (error instanceof DockerLogsPolicyError) {
      return response
        .status(error.status)
        .json(errorBody("Log stream unavailable", requestId, { code: error.code }));
    }

    if (error instanceof DockerLogsSubscriptionMissingError) {
      const message =
        error.status === 410 ? "Log subscription closed" : "Log subscription not found";
      return response
        .status(error.status)
        .json(errorBody(message, requestId));
    }

    if (error instanceof DockerLogsSequenceError) {
      return response
        .status(409)
        .json(errorBody("Unexpected log batch sequence", requestId));
    }

    if (error instanceof DockerLogsProtocolError) {
      return response
        .status(error.status)
        .json(errorBody("Invalid log payload", requestId, { code: error.code }));
    }

    if (
      error instanceof DemoMutationBlockedError ||
      error instanceof DemoSshDisabledError ||
      error instanceof SshHostBlockedError
    ) {
      return response
        .status(403)
        .json(errorBody(safeErrorMessage(error), requestId));
    }

    if (error instanceof SshOperationError) {
      return response
        .status(502)
        .json(errorBody(safeErrorMessage(error), requestId));
    }

    if (error instanceof SshHostKeyScanFailedError) {
      return response
        .status(502)
        .json(errorBody(safeErrorMessage(error), requestId));
    }

    if (error instanceof SshHostKeyTrustRequiredError) {
      return response.status(409).json({
        error: {
          message: safeErrorMessage(error),
          ...error.info,
        },
      });
    }

    if (error instanceof AgentAuthError) {
      return response
        .status(401)
        .json(errorBody(safeErrorMessage(error), requestId));
    }

    if (error instanceof DuplicateAgentInstallError) {
      return response
        .status(409)
        .json(errorBody(safeErrorMessage(error), requestId));
    }

    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string" &&
      error.code === "ENOENT"
    ) {
      return response
        .status(404)
        .json(errorBody("Required resource not found", requestId));
    }

    // The shared JSON parser still enforces its own ceiling (now 1mb). Any
    // payload that exceeds it must answer 400 body_too_large — never 500 —
    // with a fixed safe code, never parser detail.
    if (typeof error === "object" && error !== null) {
      const parserStatus =
        "status" in error && typeof error.status === "number"
          ? error.status
          : undefined;
      const parserStatusCode =
        "statusCode" in error && typeof error.statusCode === "number"
          ? error.statusCode
          : undefined;
      const parserType =
        "type" in error && typeof error.type === "string" ? error.type : undefined;
      if (
        parserStatus === 413 ||
        parserStatusCode === 413 ||
        parserType === "entity.too.large"
      ) {
        return response
          .status(400)
          .json(errorBody("Invalid log payload", requestId, { code: "body_too_large" }));
      }
    }

    if (error instanceof HttpException) {
      const payload: unknown = error.getResponse();
      const responseBody =
        typeof payload === "object" && payload !== null ? payload : undefined;

      // Standard NestJS HttpException responses are
      // { statusCode, message, error } where `error` is the HTTP error name
      // (a plain string). Nested payloads are { error: { message } }.
      // Prefer the nested error.message when truly nested, otherwise use the
      // top-level message string. Array messages (validation detail lists)
      // and other non-string payloads intentionally fall through to the safe
      // generic response.
      let nestedError: object | undefined;
      if (
        responseBody !== undefined &&
        "error" in responseBody &&
        typeof responseBody.error === "object" &&
        responseBody.error !== null
      ) {
        nestedError = responseBody.error;
      }
      let message: unknown;
      if (responseBody !== undefined) {
        let nestedMessage: unknown;
        if (
          nestedError !== undefined &&
          "message" in nestedError &&
          typeof nestedError.message === "string"
        ) {
          nestedMessage = nestedError.message;
        }
        let topMessage: unknown;
        if ("message" in responseBody && typeof responseBody.message === "string") {
          topMessage = responseBody.message;
        }
        if (nestedMessage !== undefined) {
          message = nestedMessage;
        } else if (topMessage !== undefined) {
          message = topMessage;
        }
      } else {
        message = error.message;
      }

      // Whitelist machine-readable contract fields (e.g. error codes, the
      // conflicting job id, and the incompatibility reason) from nested payloads.
      const extra: Record<string, string> = {};
      if (nestedError !== undefined) {
        if ("code" in nestedError && typeof nestedError.code === "string") {
          extra.code = nestedError.code;
        }
        if ("jobId" in nestedError && typeof nestedError.jobId === "string") {
          extra.jobId = nestedError.jobId;
        }
        if ("reason" in nestedError && typeof nestedError.reason === "string") {
          extra.reason = nestedError.reason;
        }
      }

      return response
        .status(error.getStatus())
        .json(
          errorBody(
            typeof message === "string"
              ? safeErrorMessage(message)
              : "Request failed",
            requestId,
            extra,
          ),
        );
    }

    return response
      .status(500)
      .json(errorBody("Internal server error", requestId));
  }
}

Catch()(ApiExceptionFilter);
