# Future AI Engineering Take-Home: Knowledge-Graph Coach Dashboard

## 1. Project summary

Build a full-stack coach dashboard. The dashboard must do these tasks:

1. Generate safe and personalized workouts.
2. Let a coach use an AI copilot to find member information.

You can select the technology stack. Explain the reasons for your selection.

Use synthetic data only. Do not use real member data or protected health information (PHI).

This project has two primary technical subjects:

- A multi-agent workflow
- A knowledge-graph architecture

We will evaluate your design decisions and the working application. Give the same importance to both items.

For workout personalization, consider the member's product journey. Also, consider how different types of data change over time.

## 2. Primary constraint

The knowledge graph must control the recommendations. The language model must not control the recommendations by itself.

The system must map each coach request to canonical graph concepts. These concepts include anatomy, equipment, injuries, and related data.

Use the graph structure to make safe decisions that a person can audit.

Use deterministic graph traversal to apply safety constraints. Do not apply a safety constraint only as an instruction in a language-model prompt.

## 3. Purpose

Coaches must review many types of member data before they give advice. This data includes workouts, injuries, goals, adherence, messages, and biomarkers. This manual review takes too much time.

Build a system that collects and connects this information for the coach. The system must help the coach do these tasks:

- Generate workouts more quickly.
- Personalize recommendations for many members.
- Prevent recommendations that can make an injury worse.
- Explain and audit each recommendation.

## 4. Dashboard requirements

Build one dashboard with two primary surfaces.

### 4.1 Workout Generator

The coach must supply these inputs:

- A text prompt
- A time window

Example prompts:

- `Full-body exercise with isolation around my pecs.`
- `Lower-body exercises that do not make a knee injury worse.`

The system must send the inputs to an agentic workflow runtime. The browser must show a structured workout. The workout must contain these sections and details:

- Warm-up
- Main workout
- Cooldown
- Sets
- Repetitions
- Rest periods

The coach must be able to adjust the workout. The graph must control each adjustment.

| Coach instruction | Required system response |
|---|---|
| `Exclude deadlifts.` | Do not include a deadlift variation. |
| `Her left knee is bothering her.` | Exclude or lower the rank of exercises that stress the knee. Use the anatomy hierarchy. Include knee substructures in this check. |
| `She has no barbell, only dumbbells and a kettlebell.` | Exclude exercises that require a barbell. Find equivalent exercises that use the available equipment. |

For each generated workout, show a short provenance trace. The trace must give this information:

- The reason that the system selected each exercise
- The graph path that supports the selection
- The exercises or movements that the system removed for safety

### 4.2 Coach AI Copilot

Build a chat panel that retrieves information from the member context.

A coach starts work on a member in the morning and completes the member brief. For example, the coach can do these tasks:

1. Congratulate the member for yesterday's workout.
2. Check the member's churn risk.

The chat panel must have a quick-prompt palette and charts.

Example member prompts:

- `Show me the brief.`
- `How is adherence changing?`
- `Show sleep data for this week.`
- `What changed since last week?`

Example chart prompts:

- `Plot the adherence trend.`
- `Show the message pattern.`
- `Compare the last four weeks.`

The coach must be able to do these tasks:

- See past chat messages and images.
- Ask follow-up questions.
- Get answers that use the member data.

Do not invent member information.

## 5. Knowledge graphs

Build two knowledge graphs.

### 5.1 Knowledge Graph 1: Movement and Clinical Domain

This graph must represent human movement and the exercise catalog. Use published ontologies to support the graph design.

Use these node types:

- Exercise
- Muscle
- Joint or body region
- Movement pattern
- Equipment
- Injury or condition

Use these edge types:

| Edge | Meaning |
|---|---|
| `targets` | An exercise targets a muscle. |
| `stresses` | An exercise applies stress to a joint or body region. |
| `requires` | An exercise requires equipment. |
| `part-of` | An anatomy concept is part of another anatomy concept. Use this edge to include substructures when the system checks a region such as the knee. |
| `contraindicated-for` | An injury makes a movement unsafe. |

The exercise dataset contains this taxonomy:

- 19 muscle groups
- 9 joints
- 36 movement patterns
- 32 equipment types

Map this taxonomy to ontology concepts. Use SKOS for the mappings. Use PROV-O to record why the system selected each exercise.

### 5.2 Knowledge Graph 2: Member Context

This graph must represent the member's context. Load the initial data from [`data/member-context.json`](./data/member-context.json).

Include these data types:

- Profile
- Goals
- Preferences
- Injuries
- Coach and member chat history
- Biomarkers, including resting heart rate, heart-rate variability, and sleep
- Laboratory results, including a blood panel and a DEXA scan
- Workout history
- Adherence
- Churn signals

The copilot must retrieve member information from this graph.

## 6. Required build tasks

Complete these tasks.

### 6.1 Build the Movement and Clinical Domain graph

Build the graph and connect it to ontology concepts. Document the schema. Define each node type and edge type.

### 6.2 Build the Member Context graph

Load the supplied synthetic member data into the graph.

### 6.3 Resolve concepts

Map free text to canonical graph concepts.

Examples:

| Free text | Canonical concept |
|---|---|
| `knee` | Knee joint node |
| `kettlebell` | Kettlebell equipment node |
| `bad lower back` | Lumbar region node |

We recommend a three-pass resolver:

1. Exact match
2. Fuzzy match
3. Embedding or vector fallback

Set explicit confidence limits. If the resolver cannot find a sufficient match, continue safely and explain the result.

### 6.4 Apply safety rules with graph traversal

Use graph traversal to exclude an exercise or lower its rank. Traverse the graph for these constraints:

- Injured joints and their `part-of` relations
- Available equipment
- Explicit exclusions
- Member preferences

Do not implement a safety decision only as text in a language-model prompt.

### 6.5 Build the agentic workout runtime

Convert the coach's prompt and time window into a structured workout. Include the provenance trace.

### 6.6 Build the Coach AI Copilot

Retrieve data from the Member Context graph. The copilot must do these tasks:

- Answer member-specific questions.
- Run the quick prompts.
- Show charts.
- Show the morning brief.
- Show churn risk.

### 6.7 Build the dashboard interface

Include these functions:

- Coach login. Mock authentication is sufficient.
- Member view
- Workout Generator panel
- Copilot panel
- Charts
- Chat with message history and images

### 6.8 Add tests

At a minimum, test these components:

- Concept resolver
- Safety filter

Select the critical test paths. Explain the reasons for your selection.

### 6.9 Write the README

Write a comprehensive README. Section 11 gives the README requirements.

## 7. Ontologies and resources

Use real ontologies to support the domain graph. Use only the ontology concepts that have a clear purpose in your system. A small and well-supported selection is better than a large selection that does not affect system behavior.

| Ontology | Use | Link |
|---|---|---|
| **OPE: Ontology of Physical Exercises** | Exercises, musculoskeletal systems, equipment, and injuries | [OPE](https://bioportal.bioontology.org/ontologies/OPE) |
| **COPPER: COntextualised & Personalised Physical activity and Exercise Recommendations Ontology** | Personalization and behavior-change concepts | [COPPER](https://bioportal.bioontology.org/ontologies/COPPER) |
| **SNOMED CT through NCI EVS** | Clinical anatomy, joints, injuries, and conditions | [Browser](https://evsexplore.semantics.cancer.gov/evsexplore/concept/snomedct_us/%3Ccode%3E) and API: `https://api-evsrest.nci.nih.gov/` with `GET /api/v1/concept/snomedct_us/<code>` and terminology `snomedct_us` |
| **PROV-O: W3C Provenance Ontology** | The reason for a recommendation | [PROV-O](https://www.w3.org/TR/prov-o/) |
| **SKOS: Simple Knowledge Organization System** | Mappings between catalog terms, free-text terms, and ontology concepts | [SKOS](https://www.w3.org/TR/skos-reference/) |

This project includes a research task. You do not have to load complete ontologies. Decide what your system needs. Document your decisions about these subjects:

- The concepts that you use from each ontology
- The concepts that you do not use
- The reasons that the selected concepts and relations are necessary for safe and personalized recommendations
- The graph storage technology and schema
- The method that maps ontology concepts to the exercise catalog
- The ingestion and concept-mapping methods
- The relation between the two knowledge graphs

You can build a small ontology and align it with the published ontologies. You do not have to parse complete OWL files.

Document all important decisions and trade-offs. Include an architecture diagram. These items are mandatory.

## 8. Supplied data

All supplied data is synthetic and fictional. It does not contain real member information or PHI. The data is in the [`data/`](./data) directory.

### 8.1 Exercise data

[`data/exercises.json`](./data/exercises.json) contains 50 exercises.

Important fields include:

- `muscle_groups`
- `joints_loaded`
- `movement_patterns`
- `equipment_required`
- `priority_tier`
- `is_bilateral`
- `bilateral_pair_id`

### 8.2 Member data

[`data/member-context.json`](./data/member-context.json) contains one detailed synthetic member, Jordan Rivera.

The file contains these data types:

- Profile
- Goals
- Preferences
- Available equipment
- Injuries
- Workout history
- Adherence
- Biomarkers
- Laboratory data, including a blood panel and a DEXA scan
- Chat history
- Coach brief with morning tasks and churn risk

The data supports the required examples. Jordan has these conditions:

- A left-knee injury that is in recovery
- No barbell at home
- Decreasing adherence
- A completed workout that the coach can celebrate

If you need more data, generate synthetic data. Do not use real member or personal data.

## 9. Evaluation criteria

We will evaluate these areas.

### 9.1 Graph and ontology model

- Are the edge meanings clear?
- Does the graph control important system behavior?
- Is the implementation more than semantic search with unnecessary graph components?

### 9.2 Concept resolution

- Does the resolver understand difficult or imprecise input?
- Does it continue safely when it cannot find a match?

### 9.3 Safety traversal

- Do injury and equipment constraints come from graph traversal?
- Does the system avoid reliance on prompt instructions for safety?

### 9.4 Full-stack product design

- Does the dashboard help the coach complete important work?

### 9.5 System design and API

- Are component boundaries clear?
- Are contracts typed?
- Is the data flow easy to understand?

### 9.6 Developer experience

- Can a developer start the system with one command?
- Does the README give clear instructions?

### 9.7 Communication

- Does the documentation clearly explain decisions and trade-offs?

### 9.8 Work with incomplete requirements

- Does the solution make reasonable decisions when a requirement is open?
- Does the documentation explain these decisions?

### 9.9 Performance

Target an AI response time of less than approximately five seconds. Use tokens efficiently.

Exact performance is less important than a clear explanation of your performance decisions.

## 10. Optional functions

You can add these functions:

- Graph visualization
- Multi-agent orchestration
- Streaming responses
- Evaluation pipeline for retrieval relevance and recommendation quality
- Observability and tracing for language-model calls, tools, and graph queries
- More SNOMED grounding
- Longitudinal reasoning for progression and adherence

## 11. Deliverable

Submit a runnable GitHub repository. Include a comprehensive README. Write the README at a staff-engineer level. The README must explain and support the technical work during review.

Include these items in the README.

### 11.1 Architecture diagram

Show the primary components and the data flow. Include these components where applicable:

- Dashboard
- Agentic runtime
- Knowledge graphs
- Language model
- Vector store

You can use Mermaid, Excalidraw, or a photograph of a hand-drawn diagram.

### 11.2 Architecture and technology decisions

Identify the technologies that you used. Explain the reasons for each important selection.

### 11.3 Local start instructions

Give complete instructions to start the system locally. If possible, provide one command.

### 11.4 Use of AI during development

Explain how you used AI to build the project.

### 11.5 Challenges, trade-offs, and technical decisions

Explain important challenges and decisions. State the trade-offs clearly.

### 11.6 Production evaluation

Explain how you would evaluate the system in production. Include these subjects:

- Metrics
- Failure modes
- Safety monitoring

### 11.7 Example inputs and outputs

Include two or three example inputs and their generated workouts. Include these two cases:

- One injury case
- One limited-equipment case

For each case, show the workout and the provenance or filtering trace.

## 12. Submission

When the project is complete, send the GitHub repository link.

If a requirement is not clear, make a reasonable decision. Document the decision and its reason. We will evaluate this reasoning.
