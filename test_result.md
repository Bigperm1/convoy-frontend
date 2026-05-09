#====================================================================================================
# START - Testing Protocol - DO NOT EDIT OR REMOVE THIS SECTION
#====================================================================================================

# THIS SECTION CONTAINS CRITICAL TESTING INSTRUCTIONS FOR BOTH AGENTS
# BOTH MAIN_AGENT AND TESTING_AGENT MUST PRESERVE THIS ENTIRE BLOCK

# Communication Protocol:
# If the `testing_agent` is available, main agent should delegate all testing tasks to it.
#
# You have access to a file called `test_result.md`. This file contains the complete testing state
# and history, and is the primary means of communication between main and the testing agent.
#
# Main and testing agents must follow this exact format to maintain testing data. 
# The testing data must be entered in yaml format Below is the data structure:
# 
## user_problem_statement: {problem_statement}
## backend:
##   - task: "Task name"
##     implemented: true
##     working: true  # or false or "NA"
##     file: "file_path.py"
##     stuck_count: 0
##     priority: "high"  # or "medium" or "low"
##     needs_retesting: false
##     status_history:
##         -working: true  # or false or "NA"
##         -agent: "main"  # or "testing" or "user"
##         -comment: "Detailed comment about status"
##
## frontend:
##   - task: "Task name"
##     implemented: true
##     working: true  # or false or "NA"
##     file: "file_path.js"
##     stuck_count: 0
##     priority: "high"  # or "medium" or "low"
##     needs_retesting: false
##     status_history:
##         -working: true  # or false or "NA"
##         -agent: "main"  # or "testing" or "user"
##         -comment: "Detailed comment about status"
##
## metadata:
##   created_by: "main_agent"
##   version: "1.0"
##   test_sequence: 0
##   run_ui: false
##
## test_plan:
##   current_focus:
##     - "Task name 1"
##     - "Task name 2"
##   stuck_tasks:
##     - "Task name with persistent issues"
##   test_all: false
##   test_priority: "high_first"  # or "sequential" or "stuck_first"
##
## agent_communication:
##     -agent: "main"  # or "testing" or "user"
##     -message: "Communication message between agents"

# Protocol Guidelines for Main agent
#
# 1. Update Test Result File Before Testing:
#    - Main agent must always update the `test_result.md` file before calling the testing agent
#    - Add implementation details to the status_history
#    - Set `needs_retesting` to true for tasks that need testing
#    - Update the `test_plan` section to guide testing priorities
#    - Add a message to `agent_communication` explaining what you've done
#
# 2. Incorporate User Feedback:
#    - When a user provides feedback that something is or isn't working, add this information to the relevant task's status_history
#    - Update the working status based on user feedback
#    - If a user reports an issue with a task that was marked as working, increment the stuck_count
#    - Whenever user reports issue in the app, if we have testing agent and task_result.md file so find the appropriate task for that and append in status_history of that task to contain the user concern and problem as well 
#
# 3. Track Stuck Tasks:
#    - Monitor which tasks have high stuck_count values or where you are fixing same issue again and again, analyze that when you read task_result.md
#    - For persistent issues, use websearch tool to find solutions
#    - Pay special attention to tasks in the stuck_tasks list
#    - When you fix an issue with a stuck task, don't reset the stuck_count until the testing agent confirms it's working
#
# 4. Provide Context to Testing Agent:
#    - When calling the testing agent, provide clear instructions about:
#      - Which tasks need testing (reference the test_plan)
#      - Any authentication details or configuration needed
#      - Specific test scenarios to focus on
#      - Any known issues or edge cases to verify
#
# 5. Call the testing agent with specific instructions referring to test_result.md
#
# IMPORTANT: Main agent must ALWAYS update test_result.md BEFORE calling the testing agent, as it relies on this file to understand what to test next.

#====================================================================================================
# END - Testing Protocol - DO NOT EDIT OR REMOVE THIS SECTION
#====================================================================================================



#====================================================================================================
# Testing Data - Main Agent and testing sub agent both should log testing data below this section
#====================================================================================================

user_problem_statement: "Build me an app for car enthusiasts. This app would have a walkie talkie feature in it like Zello and use a navigation program like Waze where you could see the other car enthusiasts live on the map, with the ability to tag police and road hazards like waze. Make it Apple car play compatible. Make it have audio interface for apple music/spotify/soundcloud. voice activation aswell."

backend:
  - task: "Voice transcribe endpoint with improved intent classifier"
    implemented: true
    working: "NA"
    file: "backend/server.py"
    stuck_count: 0
    priority: "high"
    needs_retesting: true
    status_history:
        - working: "NA"
          agent: "main"
          comment: "Refactored /api/voice/transcribe to use a new _classify_intent helper. Added intents: navigate_to (with extracted query: 'navigate to/drive to/take me to/go to/route to ___'), clear_route ('stop navigation', 'cancel route'), open_hub. Returns optional 'query' field for navigate_to intent."

frontend:
  - task: "Global voice activation - VoiceController + voiceBus + geocoding"
    implemented: true
    working: "NA"
    file: "frontend/src/VoiceController.tsx, frontend/src/voiceBus.ts, frontend/src/useVoice.ts, frontend/src/VoiceFAB.tsx, frontend/app/(app)/_layout.tsx, frontend/app/(app)/map.tsx"
    stuck_count: 0
    priority: "high"
    needs_retesting: false
    status_history:
        - working: "NA"
          agent: "main"
          comment: "Mounted VoiceController globally in (app)/_layout.tsx so the mic FAB and transcript banner appear on every tab (Map/Talk/Drive/Music/Hub). useVoice now broadcasts to voiceBus so any screen can subscribe. VoiceFAB removed from map.tsx (now only the global one). Added geocodeQuery in voiceBus.ts using Google Find Place + Geocoding API to resolve spoken destinations. Map screen subscribes to bus to: report hazards (police/accident/road/traffic), navigate_to (with geocoding fallback), and clear_route. Replaced disruptive Alert.alert with a non-blocking glass banner that shows transcript + recognized action and auto-dismisses after 3.2s. VoiceFAB now pulses while recording. Also fixed pre-existing syntax error in ConvoyMap.web.tsx (leftover stray text on line 135) that was blocking metro bundling."

metadata:
  created_by: "main_agent"
  version: "1.0"
  test_sequence: 0
  run_ui: false

test_plan:
  current_focus:
    - "Voice transcribe endpoint with improved intent classifier"
  stuck_tasks: []
  test_all: false
  test_priority: "high_first"

agent_communication:
    - agent: "main"
      message: "Wired up global voice activation. Backend has new intent classifier (navigate_to with query, clear_route, open_hub). Frontend VoiceFAB now lives in the (app) layout so it floats over every tab; useVoice publishes to a voiceBus, VoiceController shows a non-blocking transcript banner and routes 'open_*' intents. Map subscribes to the bus and acts on report_*, navigate_to (Google geocoding), clear_route. Please test ONLY backend /api/voice/transcribe shape — frontend voice testing requires real audio + mic permission and is best done by the user in Expo Go."