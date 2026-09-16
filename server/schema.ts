import { z } from 'zod';
export const idSchema = z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/);
export const positionSchema = z.object({ x: z.number().finite().min(-1e7).max(1e7), y: z.number().finite().min(-1e7).max(1e7) });
export const nodeDataSchema = z.object({
  kind: z.enum(['text','image','video']), title: z.string().max(200), prompt: z.string().max(30000),
  text: z.string().max(100000).optional(), url: z.string().max(3000).optional(), assetId: idSchema.optional(),
  model: z.string().max(200).optional(), aspectRatio: z.enum(['1:1','16:9','9:16','4:3','3:4','3:2','2:3','21:9','adaptive']).optional(),
  duration: z.number().int().min(2).max(20).optional(), status: z.enum(['queued','running','succeeded','failed']).optional(),
  error: z.string().max(2000).optional(), jobId: idSchema.optional(), shotNumber: z.number().int().min(1).max(1000).optional(),
});
export const nodeSchema = z.object({id:idSchema,type:z.literal('creative'),position:positionSchema,data:nodeDataSchema});
export const edgeSchema = z.object({id:idSchema,source:idSchema,target:idSchema,sourceHandle:z.string().max(100).nullable().optional(),targetHandle:z.string().max(100).nullable().optional()});
export const canvasSchema = z.object({nodes:z.array(nodeSchema).max(500),edges:z.array(edgeSchema).max(2000),viewport:z.object({x:z.number().finite(),y:z.number().finite(),zoom:z.number().min(.05).max(10)}),version:z.number().int().nonnegative()});
export const settingsSchema = z.object({imageProvider:z.enum(['openai','bailian']).optional(),videoProvider:z.enum(['ark','bailian']).optional(),textBaseUrl:z.string().trim().max(2000).optional(),textKey:z.string().trim().max(16000).optional(),textModel:z.string().max(200).optional(),imageBaseUrl:z.string().trim().max(2000).optional(),imageKey:z.string().trim().max(16000).optional(),imageModel:z.string().max(200).optional(),videoBaseUrl:z.string().trim().max(2000).optional(),videoKey:z.string().trim().max(16000).optional(),videoModel:z.string().max(200).optional()}).strict();
export const agentBodySchema = z.object({message:z.string().trim().min(1).max(20000),skillId:z.string().max(100).optional(),model:z.string().max(200).optional(),attachmentIds:z.array(idSchema).max(8).optional()}).strict();
