import { run, HandlerContext } from "@xmtp/message-kit";
import { skills } from "./skills.js";
run(
  async (context: HandlerContext) => {
    // Get the message and the address from the sender
    const { content, sender } = context.message;

    // To reply, just call `reply` on the HandlerContext
    await context.send(`gm`);
  },
  {
    skills: skills,
  },
);
