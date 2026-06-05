import pino from "pino";
import { config } from "../config";

export const logger = pino({
  level: config.logging.level,
  transport: {
    targets: [
      {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "SYS:standard" },
        level: config.logging.level,
      },
      {
        target: "pino/file",
        options: { destination: "./logs/sonyx.log", mkdir: true },
        level: config.logging.level,
      },
    ],
  },
});
