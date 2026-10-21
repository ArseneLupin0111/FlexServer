import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from "@nestjs/common";
import { map } from "rxjs/operators";
import { redactValue } from "../common/redaction.js";

@Injectable()
export class AiResponseInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    const req = context.switchToHttp().getRequest<{ url?: string }>();
    const isPreview = typeof req?.url === "string" && req.url.includes("/preview");
    return next.handle().pipe(
      map((data) => {
        if (isPreview && data && typeof data === "object") {
          return { data };
        }
        return { data: redactValue(data) };
      }),
    );
  }
}
