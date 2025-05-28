# Use an official Node.js runtime as a parent image with version 22
FROM node:22-alpine

# Set the working directory in the container
WORKDIR /usr/src/app

COPY package*.json ./

# Install application dependencies
RUN npm install

# Copy the TypeScript source code to the working directory
COPY . .

RUN npm run build

# Expose the port your MCP server listens on 
EXPOSE 3000

CMD [ "npm", "run", "dev" ]