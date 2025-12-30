const recruitmentOpenApiSpec = {
  openapi: '3.0.0',
  info: {
    title: 'Recruitment Utilities API',
    version: '1.0.0',
    description:
      'Helper endpoints that allow automation workflows to manage roles and candidate browsing in the recruitment pipeline.'
  },
  servers: [{ url: 'http://localhost:3000' }],
  paths: {
    '/api/recruitment/roles': {
      post: {
        summary: 'Create a recruitment role',
        description: 'Adds a new role/position that candidates can be mapped to.',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/RecruitmentRoleRequest' }
            }
          }
        },
        responses: {
          201: {
            description: 'Role created successfully',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/RecruitmentRole' }
              }
            }
          },
          400: { description: 'Validation error' }
        }
      }
    },
    '/api/recruitment/candidates': {
      post: {
        summary: 'Register a candidate',
        description:
          'Creates a candidate profile mapped to a role. CV uploads are optional but supported as base64 payloads.',
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/RecruitmentCandidateRequest' }
            }
          }
        },
        responses: {
          201: {
            description: 'Candidate created',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/CandidateSummary' }
              }
            }
          },
          400: { description: 'Validation error' },
          404: { description: 'Role not found' }
        }
      }
    },
    '/api/recruitment/candidates/by-role': {
      get: {
        summary: 'Browse candidates by role',
        description:
          'Lists candidates associated with a specific role identifier or title. Provide roleId or roleTitle.',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            in: 'query',
            name: 'roleId',
            required: false,
            schema: { type: 'integer' },
            description: 'Role identifier returned by the role creation endpoint.'
          },
          {
            in: 'query',
            name: 'roleTitle',
            required: false,
            schema: { type: 'string' },
            description: 'Role title to match when the identifier is unknown.'
          }
        ],
        responses: {
          200: {
            description: 'Matching candidates',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/RoleCandidateList' }
              }
            }
          },
          400: { description: 'Missing or invalid role identifier' },
          404: { description: 'Role not found' }
        }
      }
    },
    '/api/recruitment/candidates/summary': {
      get: {
        summary: 'Get candidate summary by name',
        description: 'Returns candidate summaries for a name query.',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            in: 'query',
            name: 'name',
            required: true,
            schema: { type: 'string' },
            description: 'Full or partial candidate name to search for.'
          }
        ],
        responses: {
          200: {
            description: 'Candidate summary results',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/CandidateSummarySearchResponse' }
              }
            }
          },
          400: { description: 'Name query missing' }
        }
      }
    },
    '/api/recruitment/candidates/by-name': {
      get: {
        summary: 'Browse candidates by name',
        description:
          'Performs a case-insensitive name search and returns the most recently updated matches.',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            in: 'query',
            name: 'name',
            required: true,
            schema: { type: 'string' },
            description: 'Full or partial candidate name to search for.'
          }
        ],
        responses: {
          200: {
            description: 'Matching candidates',
            content: {
              'application/json': {
                schema: {
                  type: 'array',
                  items: { $ref: '#/components/schemas/CandidateSummary' }
                }
              }
            }
          },
          400: { description: 'Name query missing' }
        }
      }
    },
    '/api/recruitment/roles/{id}/applications/count': {
      get: {
        summary: 'Count applications for a role',
        description: 'Returns how many applications have been submitted for a role.',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            in: 'path',
            name: 'id',
            required: true,
            schema: { type: 'integer' },
            description: 'Role identifier.'
          }
        ],
        responses: {
          200: {
            description: 'Application count result',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/RoleApplicationCount' }
              }
            }
          },
          400: { description: 'Missing or invalid role identifier' },
          404: { description: 'Role not found' }
        }
      }
    },
    '/api/recruitment/roles/{id}/hired': {
      get: {
        summary: 'Check if a role has hired candidates',
        description: 'Indicates whether any candidate has been hired for a role.',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            in: 'path',
            name: 'id',
            required: true,
            schema: { type: 'integer' },
            description: 'Role identifier.'
          }
        ],
        responses: {
          200: {
            description: 'Hired candidate summary',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/RoleHiringStatus' }
              }
            }
          },
          400: { description: 'Missing or invalid role identifier' },
          404: { description: 'Role not found' }
        }
      }
    },
    '/api/recruitment/roles/{id}/interviews': {
      get: {
        summary: 'List interview selections for a role',
        description: 'Returns candidates selected for interviews for a role.',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            in: 'path',
            name: 'id',
            required: true,
            schema: { type: 'integer' },
            description: 'Role identifier.'
          }
        ],
        responses: {
          200: {
            description: 'Interview candidate summary',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/InterviewSelectionList' }
              }
            }
          },
          400: { description: 'Missing or invalid role identifier' },
          404: { description: 'Role not found' }
        }
      }
    },
    '/api/recruitment/candidates/{id}/cv': {
      get: {
        summary: 'Download a candidate CV',
        description: 'Streams the latest uploaded CV document for a candidate.',
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            in: 'path',
            name: 'id',
            required: true,
            schema: { type: ['integer', 'string'] },
            description: 'Candidate identifier.'
          }
        ],
        responses: {
          200: {
            description: 'Candidate CV file stream',
            content: {
              'application/octet-stream': {
                schema: { type: 'string', format: 'binary' }
              }
            }
          },
          404: { description: 'CV not found' }
        }
      }
    }
  },
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT'
      }
    },
    schemas: {
      RecruitmentRoleRequest: {
        type: 'object',
        required: ['title'],
        properties: {
          title: { type: 'string', description: 'Display title for the role.' },
          department: { type: 'string', nullable: true },
          description: { type: 'string', nullable: true }
        }
      },
      RecruitmentRole: {
        allOf: [
          { $ref: '#/components/schemas/RecruitmentRoleRequest' },
          {
            type: 'object',
            properties: {
              id: { type: 'integer' },
              createdAt: { type: 'string', format: 'date-time' },
              updatedAt: { type: 'string', format: 'date-time' }
            }
          }
        ]
      },
      CvUpload: {
        type: 'object',
        required: ['filename', 'data'],
        properties: {
          filename: { type: 'string' },
          contentType: {
            type: 'string',
            description: 'MIME type describing the uploaded document.'
          },
          data: {
            type: 'string',
            format: 'byte',
            description: 'Base64-encoded CV file contents.'
          }
        }
      },
      RecruitmentCandidateRequest: {
        type: 'object',
        required: ['roleId', 'name', 'contact'],
        properties: {
          roleId: { type: 'integer', description: 'Identifier of the associated role.' },
          name: { type: 'string' },
          contact: {
            type: 'string',
            description: 'Primary contact information (email or phone).'
          },
          email: { type: 'string', format: 'email', nullable: true },
          notes: { type: 'string', nullable: true },
          status: { type: 'string', nullable: true },
          cv: { $ref: '#/components/schemas/CvUpload' }
        }
      },
      CandidateCvSummary: {
        type: 'object',
        properties: {
          filename: { type: 'string' },
          contentType: { type: 'string' },
          filePath: { type: ['string', 'null'] }
        }
      },
      CandidateSummary: {
        type: 'object',
        properties: {
          id: { type: ['integer', 'string'] },
          name: { type: 'string' },
          contact: { type: 'string' },
          email: { type: ['string', 'null'], format: 'email' },
          source: { type: ['string', 'null'] },
          status: { type: ['string', 'null'] },
          notes: { type: ['string', 'null'] },
          positionId: { type: ['integer', 'string', 'null'] },
          positionTitle: { type: ['string', 'null'] },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
          commentCount: { type: 'integer' },
          hasCv: { type: 'boolean' },
          cvFilename: { type: ['string', 'null'] },
          cvContentType: { type: ['string', 'null'] },
          cv: { $ref: '#/components/schemas/CandidateCvSummary', nullable: true }
        }
      },
      RoleCandidateList: {
        type: 'object',
        properties: {
          roleId: { type: ['integer', 'null'] },
          roleTitle: { type: ['string', 'null'] },
          count: { type: 'integer' },
          candidates: {
            type: 'array',
            items: { $ref: '#/components/schemas/CandidateSummary' }
          }
        }
      },
      CandidateSummarySearchResponse: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          count: { type: 'integer' },
          candidates: {
            type: 'array',
            items: { $ref: '#/components/schemas/CandidateSummary' }
          }
        }
      },
      RoleApplicationCount: {
        type: 'object',
        properties: {
          roleId: { type: ['integer', 'null'] },
          roleTitle: { type: ['string', 'null'] },
          count: { type: 'integer' }
        }
      },
      RoleHiringStatus: {
        type: 'object',
        properties: {
          roleId: { type: ['integer', 'null'] },
          roleTitle: { type: ['string', 'null'] },
          hired: { type: 'boolean' },
          count: { type: 'integer' },
          candidates: {
            type: 'array',
            items: { $ref: '#/components/schemas/CandidateSummary' }
          }
        }
      },
      InterviewSelectionList: {
        type: 'object',
        properties: {
          roleId: { type: ['integer', 'null'] },
          roleTitle: { type: ['string', 'null'] },
          count: { type: 'integer' },
          candidates: {
            type: 'array',
            items: { $ref: '#/components/schemas/CandidateSummary' }
          }
        }
      }
    }
  }
};

module.exports = JSON.stringify(recruitmentOpenApiSpec, null, 2);
