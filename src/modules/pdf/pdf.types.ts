import type { LayoutPlan } from "../layout/layout.types";

export type PdfGeneratedFile = {
  type: "poster" | "engraving" | "sticker";
  filename: string;
  path: string;
  details: Record<string, unknown>;
};

export type PdfFailedFile = {
  type: "poster" | "engraving" | "sticker";
  filename: string;
  path: string;
  message: string;
};

export type PdfPipelineResult = {
  output_dir: string;
  color_space: "RGB" | "CMYK";
  warnings: string[];
  generated: PdfGeneratedFile[];
  failed: PdfFailedFile[];
};

export type GeneratePdfMaterialsInput = {
  orderId: string;
  layoutPlan: LayoutPlan;
};
