import { SkillGroup, skillAction } from "../helpers/types.js";
import { HandlerContext } from "./handlerContext";
import path from "path";

export function findSkill(
  text: string,
  skills: SkillGroup[],
): skillAction | undefined {
  const trigger = text.split(" ")[0].toLowerCase();
  for (const skillGroup of skills) {
    const handler = skillGroup.skills.find((skill) => {
      return skill?.triggers?.includes(trigger);
    });
    if (handler !== undefined) return handler;
  }
  return undefined;
}

export async function executeSkill(
  text: string,
  skills: SkillGroup[],
  context: HandlerContext,
) {
  // Use the custom text parameter
  let conversation = context.conversation;
  try {
    let skillAction = findSkill(text, skills);
    const extractedValues = parseSkill(text, skills);
    if (
      (text.startsWith("/") || text.startsWith("@")) &&
      !extractedValues?.skill
    ) {
      console.warn("Skill not valid", text);
    } else if (skillAction?.handler) {
      // Mock context for skill execution
      const mockContext: HandlerContext = {
        ...context,
        conversation,
        getV2MessageById: context.getV2MessageById.bind(context),
        isConversationV2: context.isConversationV2.bind(context),
        getCacheCreationDate: context.getCacheCreationDate.bind(context),
        message: {
          ...context.message,
          content: { ...context.message.content, ...extractedValues },
        },
        executeSkill: context.executeSkill.bind(context),
        reply: context.reply.bind(context),
        send: context.send.bind(context),
        sendTo: context.sendTo.bind(context),
        react: context.react.bind(context),
        getMessageById: context.getMessageById.bind(context),
        getReplyChain: context.getReplyChain.bind(context),
      };

      if (skillAction?.handler) return skillAction.handler(mockContext);
    } else if (skillAction) {
      console.warn("No handler for", skillAction.skill);
      return context.send(text);
    } else if (text.startsWith("/") || text.startsWith("@")) {
      console.warn("Skill not valid", text);
    } else return context.send(text);
  } catch (error) {
    if (error instanceof Error) {
      console.error(`Skill execution failed: ${error.message}`);
    } else {
      console.error("Unknown error during skill execution:", error);
    }
    throw error; // Re-throw to allow proper handling upstream
  } finally {
    context.refConv = null;
  }
}
export function findSkillGroupByTag(
  tag: string,
  skills: SkillGroup[],
): SkillGroup | undefined {
  return skills.find((skill) => skill.tag === tag);
}
export function findSkillGroup(
  text: string,
  skills: SkillGroup[],
): SkillGroup | undefined {
  let skillList = skills;
  return skillList?.find((skill) => {
    if (skill.tag && text?.includes(`${skill.tag}`)) {
      return true;
    }
    return undefined;
  });
}

export function parseSkill(
  text: string,
  skills: SkillGroup[],
): {
  skill: string | undefined;
  params: { [key: string]: string | number | string[] | undefined };
} {
  const defaultResult = {
    skill: undefined,
    params: {} as { [key: string]: string | number | string[] | undefined },
  };
  try {
    if (!text.startsWith("/") && !text.startsWith("@"))
      return { skill: undefined, params: {} };

    if (typeof text !== "string") return defaultResult;

    // Replace all "“" and "”" with "'" and '"'
    text = text.replaceAll("“", '"').replaceAll("”", '"');

    const parts = text.match(/[^\s"']+|"([^"]*)"|'([^']*)'|`([^`]*)`/g);
    if (!parts) return defaultResult;
    let commandName = parts[0].startsWith("/")
      ? parts[0].slice(1).toLowerCase()
      : parts[0].toLowerCase();

    let commandConfig: skillAction | undefined = undefined;

    for (const group of skills) {
      commandConfig = group.skills.find((cmd) =>
        cmd.skill.startsWith(`/${commandName}`),
      );
      if (commandConfig) break;
    }

    if (!commandConfig) return defaultResult;

    const values: {
      skill: string;
      params: {
        [key: string]: string | number | string[] | undefined; // Removed boolean type
      };
    } = {
      skill: commandName,
      params: {},
    };

    const expectedParams = commandConfig.params || {};
    const usedIndices = new Set();

    for (const [param, paramConfig] of Object.entries(expectedParams)) {
      const {
        type,
        values: possibleValues = [],
        plural = false,
        default: defaultValue,
      } = paramConfig;

      let valueFound = false;
      // Handle string type with no possible values
      if (type === "string" && possibleValues.length === 0) {
        const stringIndex = parts.findIndex(
          (part, idx) => !usedIndices.has(idx) && idx > 0,
        );
        if (stringIndex !== -1) {
          values.params[param] = parts[stringIndex];
          usedIndices.add(stringIndex);
          valueFound = true;
        }
      } else if (type === "quoted") {
        const quotedIndex = parts.findIndex(
          (part, idx) => /^["'`].*["'`]$/.test(part) && !usedIndices.has(idx),
        );
        if (quotedIndex !== -1) {
          values.params[param] = parts[quotedIndex].slice(1, -1);
          usedIndices.add(quotedIndex);
          valueFound = true;
        }
      } else if (type === "url") {
        const urlIndex = parts.findIndex(
          (part, idx) => /^https?:\/\//.test(part) && !usedIndices.has(idx),
        );
        if (urlIndex !== -1) {
          values.params[param] = parts[urlIndex];
          usedIndices.add(urlIndex);
          valueFound = true;
        }
      } else if (type === "prompt") {
        values.params[param] = parts.slice(1).join(" ");
        valueFound = true;
      } else if (type === "username") {
        // Updated regular expression to ensure usernames start with @
        const usernameParts = parts.reduce<string[]>((acc, part, idx) => {
          if (
            !usedIndices.has(idx) &&
            (/^@[a-zA-Z][a-zA-Z0-9_-]*$/.test(part) ||
              /^[a-zA-Z0-9-]+\.eth$/.test(part)) // Ensure it starts with @ or is a .eth domain
          ) {
            usedIndices.add(idx);
            // Handle potential comma-separated values
            const usernames = part.split(",");
            acc.push(...usernames);
          }
          return acc;
        }, []);

        if (usernameParts.length > 0) {
          values.params[param] = plural ? usernameParts : usernameParts[0];
          valueFound = true;
        }
      } else if (type === "address") {
        // Handle comma-separated addresses
        const addressParts = parts.reduce<string[]>((acc, part, idx) => {
          if (!usedIndices.has(idx) && /^0x[a-fA-F0-9]{40}$/.test(part)) {
            usedIndices.add(idx);
            const addresses = part.split(",").map((a) => a.trim());
            acc.push(...addresses);
          }
          return acc;
        }, []);

        if (addressParts.length > 0) {
          values.params[param] =
            addressParts.length === 1 ? addressParts[0] : addressParts;
          valueFound = true;
        }
      } else if (type === "number") {
        const numberIndex = parts.findIndex(
          (part, idx) =>
            !usedIndices.has(idx) && !Number.isNaN(parseFloat(part)),
        );
        if (numberIndex !== -1) {
          values.params[param] = parseFloat(parts[numberIndex]);
          usedIndices.add(numberIndex);
          valueFound = true;
        }
      } else if (possibleValues.length > 0) {
        const index = parts.findIndex(
          (part, idx) =>
            possibleValues.includes(part.toLowerCase()) &&
            !usedIndices.has(idx),
        );
        if (index !== -1) {
          values.params[param] = parts[index];
          usedIndices.add(index);
          valueFound = true;
        }
      }
      if (!valueFound && defaultValue !== undefined) {
        if (
          typeof defaultValue === "string" ||
          typeof defaultValue === "number" ||
          Array.isArray(defaultValue)
        ) {
          values.params[param] = defaultValue;
        }
      }
    }

    return values;
  } catch (e) {
    console.error(e);
    return defaultResult;
  }
}

export async function loadSkillsFile(): Promise<SkillGroup[]> {
  const resolvedPath = path.resolve(process.cwd(), "dist/skills.js");
  let skills: SkillGroup[] = [];
  try {
    const module = await import(resolvedPath);
    skills = module?.skills;
  } catch (error) {
    // if (process.env.MSG_LOG === "true")
    //   console.error(`Error loading command config from ${resolvedPath}:`);
  }
  if (skills === undefined || skills?.length === 0) return [];
  return skills;
}
